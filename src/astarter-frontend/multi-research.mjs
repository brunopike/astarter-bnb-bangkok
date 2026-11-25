import {observationPrice} from './product-data.mjs';
export const DIMENSIONS=[['trend','行情结构'],['depth','流动性'],['macro','宏观'],['social','舆情'],['chain','链上'],['risk','风险']];
export const RESEARCH_GROUPS=[
 {label:'市场结构',color:'#8a6fff',glyph:'chart',name:'趋势研究组',roles:[0,1,2],assets:['BTC'],source:'trend'},
 {label:'链上生态',color:'#00b68c',glyph:'nodes',name:'生态研究组',roles:[3,7,8],assets:['ETH'],source:'chain'},
 {label:'情绪异动',color:'#de6cbc',glyph:'pulse',name:'异动研究组',roles:[4,16,17],assets:['SOL'],source:'social'},
 {label:'全球权益',color:'#5a98f3',glyph:'bars',name:'权益研究组',roles:[6,10,11],assets:['SPX','NDX'],source:'trend'},
 {label:'避险轮动',color:'#ecb427',glyph:'diamond',name:'避险研究组',roles:[5,9,14],assets:['XAU'],source:'macro'},
 {label:'宏观事件',color:'#f5866a',glyph:'calendar',name:'宏观研究组',roles:[12,13,15],assets:['DXY','US10Y'],source:'macro'}
];
export function researchRoleColor(id){return RESEARCH_GROUPS.find(group=>group.roles.includes(id))?.color||RESEARCH_GROUPS[0].color;}
const FIXTURES={
 BTC:{name:'比特币',outcome:'watch',title:'等待结构确认',thesis:'结构修复，但流动性尚未同步；保留观察。',next:'等待价格结构与盘口同时确认。',evidence:['区间上沿尚未形成有效确认','盘口支撑存在，但厚度未持续增加','利率事件临近，降低方向性权重','讨论升温，独立来源不足','大额转账仅作旁证，不等同于卖出','等待结构确认；限制组合相关性敞口']},
 ETH:{name:'以太坊',outcome:'candidate',title:'进入策略候选',thesis:'结构与流动性证据一致，链上流入提供旁证。',next:'可交给操作台，核对额度与保护条件后模拟。',evidence:['回踩结构与中周期方向一致','双边深度恢复，价差处于示例阈值内','利率背景纳入压力情景','生态讨论有多来源交叉印证','资金流入获另一数据切片旁证','示例风险条件齐备，仍需执行侧额度检查']},
 SOL:{name:'Solana',outcome:'conflict',title:'分歧 · 暂缓跟进',thesis:'舆情热度上升，但大额流动与盘口证据相反。',next:'补查流动归因，未消除分歧前不进入执行。',evidence:['短周期走强，中周期尚未确认','薄盘口放大冲击，存在反向证据','高波动资产对宏观冲击更敏感','热度集中，不能作为独立交易信号','转入交易所样例与买盘支持相冲突','分歧未解，禁止模拟新单']},
 SPX:{name:'标普 500',outcome:'watch',title:'等待事件落地',thesis:'板块强弱不一，宏观事件前保留观察。',next:'对照事件结果与板块广度，暂不形成执行任务。',evidence:['指数结构修复，板块广度尚未同步','使用指数成交代理，不伪装成交易盘口','等待经济事件确认','新闻情绪偏正面，作为旁证',null,'事件风险未落地，维持观察']},
 NDX:{name:'纳斯达克 100',outcome:'missing',title:'待补 · 权重证据',thesis:'指数走强，但权重集中度证据仍缺失。',next:'补齐权重及广度样例后重新核验。',evidence:['上涨集中于少数权重股','指数成交代理仅作旁证','利率上行情景影响估值','新闻集中于科技板块',null,'缺少集中度核验记录，暂不放行']},
 XAU:{name:'黄金',outcome:'candidate',title:'避险候选 · 待跟踪',thesis:'避险需求与利率背景形成交叉支持。',next:'跟踪美元与实际利率；当前没有 TradFi 执行适配。',evidence:['回撤后结构保持','使用黄金报价代理观察流动性','利率与避险需求形成交叉支持','避险叙事保留为旁证',null,'保留方向候选，等待执行市场适配']},
 DXY:{name:'美元指数',outcome:'context',title:'共享美元背景',thesis:'美元变化作为加密、权益与黄金的共同风险背景。',next:'共享给相关组，不单独形成交易信号。',evidence:['美元区间变化已归入跨资产背景','指数代理仅作观察','美元方向与利率预期对照','宏观新闻交叉核对',null,'背景证据不能单独放行策略']},
 US10Y:{name:'美债十年期',outcome:'context',title:'共享利率背景',thesis:'利率变化用于压力情景，不直接推导资产涨跌。',next:'同步给权益与避险组，检查事件窗口。',evidence:['收益率走势用于情景比较','不以收益率伪造可交易盘口','事件窗口与利率预期对照','宏观消息核对发布时间',null,'仅作背景，不单独生成执行任务']}
};
export const PHASE_NAMES={queued:'排队研究',collect:'采集证据',verify:'组内核验',queuedCore:'等待汇总',core:'核心复核',complete:'结论已汇总'};
const sharedDefs=[['macro','宏观日历','利率事件与美元背景',['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y']],['social','舆情交叉核验','来源去重与情绪分歧',['BTC','ETH','SOL']],['chain','链上异动','大额转账与资金流旁证',['BTC','ETH','SOL']]];
export class MultiResearch{
 constructor(){this.time=0;this.sequence=0;this.events=[];this.core=null;this.shared=sharedDefs.map(([id,name,summary,assets])=>({id,name,summary,assets,version:1,at:0}));this.tasks=Object.entries(FIXTURES).map(([symbol,f],i)=>({...f,symbol,id:'research-'+symbol,version:1,group:RESEARCH_GROUPS.findIndex(g=>g.assets.includes(symbol)),domain:['BTC','ETH','SOL'].includes(symbol)?'Crypto':'TradFi',phase:'queued',started:null,completed:null,progress:0,reason:'首轮跨资产扫描',evidence:[],history:[]}));this.groups=RESEARCH_GROUPS.map((g,i)=>({...g,station:i,task:null}));this.assign();}
 log(task,text){this.events.unshift({id:++this.sequence,at:this.time,symbol:task?.symbol||'共享',text});this.events.length=Math.min(32,this.events.length);}
 task(symbol){return this.tasks.find(t=>t.symbol===symbol?.split('/')[0]);}
 revision(t){return `${t.id}:v${t.version}`;}
 accepts(t){return !this.scope||this.scope==='all'||t.domain.toLowerCase()===this.scope;}
 setScope(scope){this.scope=['all','crypto','tradfi'].includes(scope)?scope:'all';for(const t of this.tasks){if(!this.accepts(t)){if(t.phase!=='complete'){t.phase='queued';t.started=null;t.progress=0;}this.groups[t.group].task=null;if(this.core?.symbol===t.symbol)this.core=null;}}this.assign();}
 assign(){for(const g of this.groups){if(g.task)continue;const t=this.tasks.find(t=>t.group===g.station&&t.phase==='queued'&&this.accepts(t));if(!t)continue;g.task=t.symbol;t.phase='collect';t.started=this.time;this.applyContext(t);t.duration=18+g.station*2;t.evidence=DIMENSIONS.map(([key,name],i)=>({id:`${this.revision(t)}:${key}`,key,name,sourceId:t.external?.[key]?.id||`fixture-${t.symbol}-${key}`,source:key==='macro'?'宏观日历样例':key==='social'?'舆情去重样例':key==='chain'?'链上资金流样例':'市场与规则样例',text:(key==='risk'&&t.outcome!==FIXTURES[t.symbol].outcome?t.next:null)||t.external?.[key]?.reason||this.shared.find(s=>s.id===key&&s.decision&&s.decision!=='context')?.summary||FIXTURES[t.symbol].evidence[i],status:FIXTURES[t.symbol].evidence[i]===null?'na':'pending',sharedVersion:this.shared.find(s=>s.id===key)?.version??null}));this.log(t,g.name+' 开始采集 · v'+t.version);}}
 advance(dt,{busyRoles=[]}={}){if(!Number.isFinite(dt)||dt<=0)return;for(let left=dt;left>0;){const step=Math.min(.1,left);left-=step;this.time+=step;this.step(step,busyRoles);}}
 step(dt=0,busyRoles=[]){
  for(const t of this.tasks){t.executionWaiting=this.groups[t.group].roles.some(id=>busyRoles.includes(id));if(t.executionWaiting&&['collect','verify'].includes(t.phase))t.started+=dt;}if(this.core&&this.task(this.core.symbol).executionWaiting)this.core.at+=dt;
  for(const t of this.tasks){if(!['collect','verify'].includes(t.phase))continue;const age=this.time-t.started,u=Math.min(1,age/t.duration);t.progress=Math.min(72,Math.floor(u*72));t.phase=u<.34?'collect':'verify';t.evidence.forEach((e,i)=>{if(e.status==='na')return;if(u>(.20+i*.09))e.status='collected';if(u>(.48+i*.085))e.status=this.decision(t,e);});if(u>=1){t.phase='queuedCore';t.queuedAt=this.time;this.log(t,'组内核验完成，报告等待核心');}}
  if(!this.core){const t=this.tasks.filter(t=>t.phase==='queuedCore').sort((a,b)=>a.queuedAt-b.queuedAt)[0];if(t){this.core={symbol:t.symbol,version:t.version,at:this.time};t.phase='core';this.log(t,'向核心递交报告');}}
  if(this.core){const t=this.task(this.core.symbol),age=this.time-this.core.at;if(t.version!==this.core.version){this.core=null;return;}if(t.phase==='core'){t.progress=76+Math.min(23,Math.floor(age/7*23));if(age>=7){t.phase='complete';t.progress=100;t.completed=this.time;this.log(t,t.title+' · v'+t.version);}}if(age>=14){this.groups[t.group].task=null;this.core=null;}}
  this.assign();
  // Refresh one completed asset at a time; evidence updates invalidate only their dependencies.
  const due=this.tasks.find(t=>this.accepts(t)&&t.phase==='complete'&&this.time-t.completed>145+t.group*6&&this.groups[t.group].task!==t.symbol);if(due)this.recheck(due.symbol,'定期检查新证据');
 }
 applyContext(t){const base=FIXTURES[t.symbol];for(const k of ['outcome','title','thesis','next'])t[k]=base[k];const warnings=[...this.shared.filter(s=>s.assets.includes(t.symbol)),...Object.values(t.external||{})];const warning=warnings.find(s=>s.decision==='conflict')||warnings.find(s=>s.decision==='missing');if(warning){t.outcome=warning.decision;t.title=warning.decision==='conflict'?'新证据分歧 · 暂缓':'新证据待补 · 复核';t.thesis=warning.reason||warning.summary;t.next='核查这条新证据，未完成之前禁止交给执行。';}}
 ingest(symbol,item){const t=this.task(symbol);if(!t||!item||!['retain','context','conflict','missing'].includes(item.decision))return false;const key=DIMENSIONS.some(([k])=>k===item.source)?item.source:'risk';t.external={...(t.external||{}),[key]:{id:item.id,decision:item.decision,reason:item.reason}};return this.recheck(symbol,'新增样例：'+item.title);}
 decision(t,e){const external=t.external?.[e.key],shared=this.shared.find(s=>s.id===e.key&&s.assets.includes(t.symbol));if(external)return external.decision;if(shared?.decision&&shared.decision!=='context')return shared.decision;if(e.key==='risk'&&t.outcome==='missing')return 'missing';if(t.outcome==='conflict'&&e.key==='risk'||FIXTURES[t.symbol].outcome==='conflict'&&['depth','chain'].includes(e.key))return 'conflict';return ['macro','social'].includes(e.key)||t.outcome==='context'?'context':'retain';}
 recheck(symbol,reason='用户发起重新核验'){
  const t=this.task(symbol);if(!t)return false;
  t.history.unshift({version:t.version,phase:t.phase,title:t.phase==='complete'?t.title:'尚未完成',at:this.time});t.history=t.history.slice(0,5);t.version++;t.phase='queued';t.started=null;t.completed=null;t.progress=0;t.reason=reason;t.evidence=[];
  if(this.groups[t.group].task===t.symbol)this.groups[t.group].task=null;if(this.core?.symbol===t.symbol)this.core=null;this.log(t,reason+' · 进入 v'+t.version);this.assign();return true;
 }
 refreshShared(id){const s=this.shared.find(s=>s.id===id);if(!s)return [];s.version++;s.at=this.time;s.decision=s.version%2===0?(id==='social'?'missing':'conflict'):'context';s.summary=s.decision==='context'?sharedDefs.find(d=>d[0]===id)[2]:id==='macro'?'高影响事件临近，新增风险需等待':id==='social'?'新增讨论缺少原始出处，先核实来源':'资金流与原有方向分歧，等待归因';this.log(null,`${s.name} v${s.version} 更新；相关任务重新排队`);for(const symbol of s.assets)this.recheck(symbol,`${s.name} v${s.version} 新证据`);return [...s.assets];}
 context(symbol,importedRevision){const t=this.task(symbol),revision=t?this.revision(t):'';return {market:t?.domain==='Crypto'?t.symbol+'/USDT':t?.symbol||'',price:t?observationPrice(t.symbol,this.time*2):0,revision,ready:Boolean(t&&this.accepts(t)&&t?.phase==='complete'&&t.domain==='Crypto'&&t.outcome==='candidate'&&importedRevision===revision),conflict:t?.evidence.filter(e=>e.status==='conflict').length||0,missing:t?.evidence.filter(e=>e.status==='missing').length||0};}
 handoff(symbol){const t=this.task(symbol);if(!t||!this.accepts(t)||t.phase!=='complete'||t.domain!=='Crypto'||t.outcome!=='candidate')return null;return Object.freeze({taskId:t.id,market:t.symbol+'/USDT',revision:this.revision(t),title:t.title,at:this.time,mode:'simulation-only'});}
 jobs(){return this.groups.map(g=>{
  const t=this.task(g.task),monitor=!t,subject=t?.symbol||g.assets.join(' / '),age=t?this.time-t.started:0;
  let progress=monitor ? .04+((this.time+g.station*2)%18)/30:t.phase==='collect'||t.phase==='verify'?Math.min(.65,age/t.duration*.65):.36+((this.time+g.station*2)%9)/9*.26;
  if(t&&this.core?.symbol===t.symbol)progress=Math.min(.90,.67+(this.time-this.core.at)/3*.15);
  const source=g.source;
  return {id:t?this.revision(t):`monitor-${g.station}`,taskId:t?.id||null,symbol:subject,revision:t?this.revision(t):null,roles:g.roles,station:g.station,groupLabel:g.label,groupColor:g.color,researchPhase:t?.phase||'monitor',discovered:Boolean(t&&['queuedCore','core','complete'].includes(t.phase)),title:`${subject} · ${monitor?'持续观察':PHASE_NAMES[t.phase]}`,source,sourceAnchor:source==='trend'?'market':null,mode:'field',progress,trigger:t?.reason||'等待下一轮证据',taskType:monitor?'monitor':'research'};
 });}
 findings(){return this.tasks.filter(t=>this.accepts(t)&&['queuedCore','core','complete'].includes(t.phase)&&['candidate','conflict','missing'].includes(t.outcome));}
 summary(){const active=this.tasks.filter(t=>this.accepts(t)),complete=active.filter(t=>t.phase==='complete');return {total:active.length,working:active.filter(t=>['collect','verify'].includes(t.phase)).length,waiting:active.filter(t=>t.phase==='queued'||t.phase==='queuedCore').length,complete:complete.length,candidates:complete.filter(t=>t.outcome==='candidate').length,blocked:complete.filter(t=>['conflict','missing'].includes(t.outcome)).length};}
 process(){const s=this.summary();return {history:[],items:[],counts:{retain:s.candidates,context:s.complete-s.candidates-s.blocked,conflict:s.blocked,missing:0},expected:8,arrived:s.complete+(this.core?1:0),resolved:s.complete,ready:s.complete>0,phase:this.core?2:s.complete?3:0,title:'多资产协作',detail:`${s.working} 组研究 · ${s.waiting} 项等待 · ${s.complete} 项已汇总`,revision:this.tasks.map(t=>this.revision(t)).join('|'),resultProgress:1};}
 snapshot(){return structuredClone({mode:'simulation-only',time:this.time,shared:this.shared,tasks:this.tasks,events:this.events});}
}

// Explicitly armed, one-shot policy. This routes discoveries, never creates orders itself.
export class DiscoveryDispatch {
 constructor(previous=null){
  this.policy=null;this.seen=new Set();this.message='等待开启机会接管';this.receipt=null;
  if(previous&&['watching','started','stopped','failed','interrupted'].includes(previous.status)&&['requestId','draftId','connectionId','accountId'].every(k=>typeof previous[k]==='string'&&previous[k].length>0&&previous[k].length<=256)&&Number.isSafeInteger(previous.version)&&previous.version>0){
   const {requestId,draftId,version,connectionId,accountId,status}=previous;this.receipt={requestId,draftId,version,connectionId,accountId,status:status==='watching'?'interrupted':status};
   this.message=status==='watching'?'页面已刷新，等待已停止；重新确认后再开始':'已恢复上次机会处理结果';
  }
 }
 arm(policy){this.policy=Object.freeze(structuredClone(policy));this.receipt={requestId:policy.botLaunch?.requestId,draftId:policy.id,version:policy.version,connectionId:policy.executionRoute?.connectionId,accountId:policy.executionRoute?.accountId,status:'watching'};this.message='正在等待已核验机会';}
 disarm(message='机会接管已关闭',status='stopped'){if(this.policy&&this.receipt)this.receipt={...this.receipt,status};this.policy=null;this.message=message;}
 next(research,trade){
  if(!this.policy)return null;
  if(trade.session&&['paused','blocked'].includes(trade.state)){this.disarm('会话已暂停或停止，请手动重新开启');return null;}
  if((trade.session&&trade.state!=='stopped')||trade.position||trade.pending)return null;
  return research.tasks.map(t=>research.handoff(t.symbol)).find(item=>item&&(!this.policy.market||item.market===this.policy.market)&&!this.seen.has(item.revision))||null;
 }
 accepted(item){this.seen.add(item.revision);this.disarm('机会已交接，当前会话独立运行','started');}
 failed(message){this.disarm(message,'failed');}
}
