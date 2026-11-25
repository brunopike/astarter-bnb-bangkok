import {pair as L} from './locale.mjs';
import {uiGlyph} from './product-composition.mjs';
import {executionActionError,executionActionFeedback} from './execution-views.mjs';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function operatorTasks(trade,access){
 const active=Boolean(trade?.discovery?.armed||trade?.session&&trade.state!=='stopped'||trade?.position||trade?.pending);
 const tasks=[
  {id:'start',icon:'orbit',title:L('让 AI 帮我开始','Let AI help me start'),description:L('选好目标、金额和保护，再确认启动','Choose a goal, amount and protection before starting'),keywords:'开始 自动交易 不劳而获 策略 推荐 start automate strategy',kind:'start'},
  {id:'plan',icon:'strategy',title:L('调整我的方案','Adjust my plan'),description:L('查看金额、执行方式和资金保护','Review amounts, execution mode and protection'),keywords:'方案 参数 金额 设置 plan settings amount risk',kind:'plan'},
  {id:'activity',icon:'pulse',title:L('看看现在运行得怎样','Check how it is running'),description:L('查看当前持仓、订单和策略状态','See positions, orders and strategy status'),keywords:'持仓 订单 运行 盈亏 交易 positions orders performance',kind:'activity'},
  {id:'ask',icon:'chat',title:L('帮我分析行情或资料','Analyze markets or material'),description:L('把问题或资料交给交易助手','Take a question or source to the trading assistant'),keywords:'分析 问答 新闻 行情 AI chat analyze news market',kind:'ask'},
  {id:'watch',icon:'search',title:L('追踪一个资产','Track an asset'),description:L('添加币种或合约地址，持续关注变化','Add an asset or contract address to your watchlist'),keywords:'追踪 添加 搜索 地址 CA watch track token',kind:'watch'},
  {id:'connect',icon:'settings',title:L('连接交易账户','Connect a trading account'),description:L('查看交易所、钱包和权限','Review exchange, wallet and permissions'),keywords:'连接 账户 API 钱包 断连 权限 account connect wallet api',kind:'connect'},
  {id:'credits',icon:'credits',title:L('查看积分与预算','Review credits and budget'),description:L('看清可用积分和研究上限','Check available credits and research limits'),keywords:'积分 充值 预算 费用 credits budget cost',kind:'credits'}
 ];
 if(active){const plan=tasks.find(t=>t.id==='plan');plan.title=L('查看当前方案','Review the current plan');plan.description=L('查看正在使用的金额和保护规则','See the allocation and protection rules in use');}
 if(trade?.pending?.status==='unknown')tasks.unshift({id:'reconcile',icon:'shield',title:L('确认待处理订单的结果','Resolve the pending order'),description:L('查询原订单，不重复提交','Check the original order without submitting again'),keywords:'查询 未知 订单 恢复 unknown pending reconcile',kind:'reconcile',priority:true});
 else if(active&&trade?.state==='running')tasks.unshift({id:'pause',icon:'pause',title:L('暂停新的交易','Pause new entries'),description:L('暂停新增交易，已有持仓保留','Pause new entries and retain existing positions'),keywords:'暂停 停一下 pause stop',kind:'pause',priority:true});
 else if(active){const task=tasks.find(t=>t.id==='activity');task.priority=true;task.description=L('先看现有持仓和待办，再决定下一步','Review your current position and next action');}
 else tasks[0].priority=true;
 if(access&&!access.ready)tasks.find(t=>t.id==='connect').description=L('当前接入需要处理，可在这里恢复','Your connection needs attention. Resolve it here.');
 return tasks.sort((a,b)=>Number(Boolean(b.priority))-Number(Boolean(a.priority)));
}
export function matchingOperatorTasks(tasks,query=''){
 const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
 return tasks.filter(task=>words.every(word=>(task.title+' '+task.description+' '+task.keywords).toLocaleLowerCase().includes(word)));
}

export function mountAIOperator({desk,onNavigate,onPlan,onAsk,notify}){
 const dialog=document.createElement('dialog');dialog.className='ai-operator';dialog.setAttribute('aria-labelledby','ai-operator-title');
 document.body.append(dialog);
 let tasks=[],query='',index=0,origin=null,dispatching=false,restoreOrigin=true;
 function filtered(){return matchingOperatorTasks(tasks,query);}
 function select(next){const rows=filtered();index=Math.max(0,Math.min(rows.length-1,next));dialog.querySelectorAll('[data-os-task]').forEach((b,i)=>b.setAttribute('aria-selected',String(index===i)));const current=dialog.querySelector('[data-os-task][aria-selected=true]');dialog.querySelector('input').setAttribute('aria-activedescendant',current?.id||'');current?.scrollIntoView({block:'nearest'});}
 function paint(){
  const list=dialog.querySelector('.ai-operator-list'),rows=filtered();
  list.innerHTML=rows.length?rows.map((task,i)=>`<button type="button" role="option" tabindex="-1" id="os-task-${task.id}" data-os-task="${task.id}" aria-selected="${i===index}"><span class="ai-operator-icon">${uiGlyph(task.icon)}</span><span><b>${esc(task.title)}</b><small>${esc(task.description)}</small></span><span class="ai-operator-enter">↵</span></button>`).join(''):`<div class="ai-operator-empty"><p>${L('把这个问题交给交易助手','Take this question to the trading assistant')}</p><button type="button" class="p-button p-primary" data-os-ask>${L('继续分析','Continue with AI')}</button></div>`;
  list.querySelectorAll('[data-os-task]').forEach(button=>{button.onclick=()=>run(button.dataset.osTask);button.onpointerenter=()=>select([...list.querySelectorAll('[data-os-task]')].indexOf(button));});
  list.querySelector('[data-os-ask]')?.addEventListener('click',()=>ask());select(index);
 }
 function ask(){const prompt=query;restoreOrigin=false;dialog.close();if(onAsk(prompt)===false){const status=dialog.querySelector('.ai-operator-feedback');status.hidden=false;status.textContent=L('对话已满，问题保留在上方。可复制后在已有对话继续。','Chat limit reached. Your question is retained above. Copy it to continue in an existing chat.');restoreOrigin=true;dialog.showModal();dialog.querySelector('input').focus();}}
 function run(id){
  if(dispatching)return;const task=tasks.find(t=>t.id===id);if(!task)return;if(task.kind==='ask'){ask();return;}dispatching=true;restoreOrigin=false;dialog.close();
  if(task.kind==='start')onNavigate('advisor');
  else if(task.kind==='plan')onPlan();
  else if(task.kind==='activity')onNavigate('execution');
  else if(task.kind==='watch')onNavigate('watchlist');
  else if(task.kind==='connect')desk.settings('exchange');
  else if(task.kind==='credits')onNavigate('usage');
  else {const before=desk.snapshot(),error=desk.action(task.kind);notify(error?executionActionError(error):executionActionFeedback(task.kind,before,desk.snapshot())?.message||L('已更新','Updated'),{tone:error?'error':'success'});onNavigate('execution');}
  dispatching=false;
 }
 function open(){
  if(dialog.open){dialog.close();return;}
  if([...document.querySelectorAll('dialog[open]')].some(el=>el.getClientRects().length))return;
  origin=document.activeElement;query='';index=0;dispatching=false;restoreOrigin=true;tasks=operatorTasks(desk.readSnapshot?desk.readSnapshot():desk.snapshot(),desk.access?.({operation:'observe'}));
  dialog.innerHTML=`<header><h2 id="ai-operator-title">${L('想让 AI 帮你做什么？','What can AI help you do?')}</h2><button type="button" class="ai-operator-close" aria-label="${L('关闭','Close')}">${uiGlyph('close')}</button></header><div class="ai-operator-search">${uiGlyph('search')}<input type="text" role="combobox" aria-autocomplete="list" aria-controls="ai-operator-options" aria-expanded="true" autocomplete="off" maxlength="2000" placeholder="${L('开始策略、看持仓，或输入一个问题','Start a strategy, check positions, or ask a question')}"></div><p class="ai-operator-feedback" role="alert" hidden></p><div class="ai-operator-list" id="ai-operator-options" role="listbox" aria-label="${L('可执行的任务','Available tasks')}"></div><footer><span>${L('↑ ↓ 选择　↵ 打开','↑ ↓ Select　↵ Open')}</span><span>Esc ${L('关闭','Close')}</span></footer>`;
  dialog.querySelector('.ai-operator-close').onclick=()=>dialog.close();
  const input=dialog.querySelector('input');input.setAttribute('aria-label',L('搜索任务或输入问题','Search tasks or enter a question'));
  input.oninput=()=>{query=input.value;index=0;dialog.querySelector('.ai-operator-feedback').hidden=true;paint();};
  input.onkeydown=e=>{if(e.isComposing)return;if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();select(e.key==='Home'?0:e.key==='End'?filtered().length-1:index+(e.key==='ArrowDown'?1:-1));}else if(e.key==='Enter'){e.preventDefault();const task=filtered()[index];task?run(task.id):query.trim()&&ask();}else if(e.key==='Escape'&&query){e.preventDefault();query='';input.value='';index=0;paint();}};
  paint();dialog.showModal();input.focus();
 }
 dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
 dialog.addEventListener('close',()=>{dispatching=false;if(restoreOrigin&&origin?.isConnected)origin.focus({preventScroll:true});});
 document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'&&!e.isComposing&&e.target?.type!=='password'){e.preventDefault();open();}});
 document.addEventListener('hive:open-operator',open);
 return {open};
}
