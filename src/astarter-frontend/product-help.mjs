import {t,pair,getLocale,translate} from './locale.mjs';
const L=pair;
const e=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const infoDetails='details:is(.dc-info,.pd-info,.sc-info,.as-info,.as-inline-info,.tc-info,.cc-billing-info)';
const infoControls=infoDetails+',button.ux-info,button.info,button.terminal-chart-info';
function isInfoIcon(control){
 if(control.tagName!=='DETAILS')return control.tagName==='BUTTON'&&(control.classList.contains('ux-info')||!control.textContent.trim());
 const summary=control.querySelector('summary'),label=summary?.textContent.trim();
 return summary&&(['i','?','ⓘ','ℹ'].includes(label)||!label&&summary.querySelector('svg'));
}

export function normalizeInfoControls(root){
 const focused=globalThis.document?.activeElement;
 const candidates=[...(root.matches?.(infoControls)?[root]:[]),...root.querySelectorAll(infoControls)],controls=candidates.filter(isInfoIcon);
 for(const control of candidates)if(control.tagName==='DETAILS'&&!controls.includes(control))control.setAttribute('data-ui-info-text','');
 // One market-card disclosure keeps both the definition and the original source nodes.
 for(const card of new Set(controls.map(c=>c.closest('.hub-panel')).filter(Boolean))){
  const header=[...card.children].find(c=>c.tagName==='HEADER'),heading=header?.querySelector('h1,h2,h3');
  const source=controls.find(c=>c.matches('.hub-source')&&c.closest('section,article')===card);
  if(!header||!heading||!source)continue;
  const body=source.querySelector('.hub-source-detail');if(!body)continue;
  for(const definition of controls.filter(c=>c!==source&&heading.contains(c))){
   const content=[...definition.children].find(c=>c.tagName!=='SUMMARY');if(!content)continue;
   content.classList.add('ui-info-description');body.prepend(content);definition.remove();
  }
  const footer=source.closest('.hub-graph-source');if(source.parentElement!==header)header.append(source);
  if(footer){if(!footer.textContent.trim()&&!footer.querySelector('a,button,details'))footer.remove();else footer.setAttribute('data-ui-info-footer','');}
 }
 for(const control of controls){
  if(!control.parentElement)continue;control.setAttribute('data-ui-info','');
  const heading=control.closest('h1,h2,h3'),assetHeader=control.matches('.hub-card-source')?control.closest('article')?.querySelector('header'):null;
  // A hint beside a hidden title leads the page actions: a repaint restores focus by order among same-named hints.
  const known=heading?.closest('header')||assetHeader||(control.parentElement.tagName==='HEADER'?control.parentElement:null),titleLine=known?null:control.closest('header.layout-context-only'),header=known||titleLine;
  if(header?.classList.contains('layout-context-only')){
   const actions=header.closest('#product-page')?.querySelector('.layout-heading-actions'),source=actions?.querySelector('.data-header-info'),help=HELP[control.dataset.info];
   if(source&&help&&control.matches('button.ux-info')){
    const body=[...source.children].find(c=>c.tagName!=='SUMMARY');
    if(body){const copy=body.ownerDocument.createElement('div');copy.className='ui-info-description';copy.textContent=L(...help[1]);body.prepend(copy);control.remove();}
   }else if(actions&&control.parentElement!==actions){if(titleLine)actions.prepend(control);else actions.append(control);}
   continue;
  }
  if(header){
   let main=heading||header.querySelector('h1,h2,h3')||header.firstElementChild;
   while(main&&main.parentElement!==header)main=main.parentElement;
   if(main&&main!==control)main.classList.add('ui-info-heading');
   header.classList.add('ui-info-header');if(control.parentElement!==header)header.append(control);
  }else if(heading)heading.classList.add('ui-info-title');
 }
 if(focused?.isConnected&&globalThis.document.activeElement!==focused&&controls.some(c=>c===focused||c.contains?.(focused)))focused.focus({preventScroll:true});
}
export function formatDataTime(value){
 const at=typeof value==='number'?value:typeof value==='string'&&value.trim()?Date.parse(value):NaN;
 return Number.isFinite(at)&&Number.isFinite(new Date(at+8*3600000).getTime())?new Date(at+8*3600000).toISOString().slice(0,19).replace('T',' ')+' UTC+8':'—';
}
export function formatSimulationTime(seconds){
 if(!Number.isFinite(seconds))return '—';
 const t=Math.max(0,Math.round(seconds)),units=[[Math.floor(t/86400),'天','d'],[Math.floor(t%86400/3600),'时','h'],[Math.floor(t%3600/60),'分','m'],[t%60,'秒','s']],i=t?units.findIndex(([v])=>v>0):3,shown=units.slice(i,i+2).filter(([v],k)=>v>0||k===0);
 return L(`模拟 ${shown.map(([v,z])=>v+z).join('')}`,`Sim ${shown.map(([v,,e])=>v+e).join(' ')}`);
}

export function infoPopoverPosition(anchor,panel,viewport){
 const inset=12,gap=8;
 return {
  left:Math.max(inset,Math.min(anchor.left+anchor.width-panel.width,viewport.width-panel.width-inset)),
  top:anchor.bottom+gap+panel.height<=viewport.height-inset?anchor.bottom+gap:Math.max(inset,Math.min(anchor.top-panel.height-gap,viewport.height-panel.height-inset)),
 };
}

export function bindInfoPopovers(root=document){
 let active=null,pinned=null,identity=0,hoverTimer=null,leaveTimer=null;
 normalizeInfoControls(root.body||root);
 const observer=new MutationObserver(records=>{
  const regions=new Set();
  for(const record of records)for(const node of record.addedNodes){
   if(node.nodeType!==1||node.namespaceURI!=='http://www.w3.org/1999/xhtml')continue;
   if(node.matches(infoControls)||node.querySelector(infoControls))regions.add(node.closest('.hub-panel')||node);
  }
  for(const region of regions)if(region.isConnected)normalizeInfoControls(region);
 });
 observer.observe(root.body||root,{childList:true,subtree:true});
 const close=()=>{
  clearTimeout(hoverTimer);clearTimeout(leaveTimer);
  const details=active||pinned;active=null;pinned=null;if(!details)return;
  details.open=false;details.removeAttribute('data-info-open');
  details.querySelector('summary')?.setAttribute('aria-expanded','false');
  const panel=details.querySelector('.ui-info-popover');
  if(panel?.isConnected&&panel.matches(':popover-open'))panel.hidePopover();
 };
 root.addEventListener('click',event=>{
  const summary=event.target.closest?.('summary'),details=summary?.parentElement;
  if(!details?.matches(infoDetails)||!isInfoIcon(details)){if(active&&!active.contains(event.target))close();return;}
  event.preventDefault();event.stopPropagation();clearTimeout(hoverTimer);clearTimeout(leaveTimer);
  if(active===details&&details.open){if(pinned===details)close();else pinned=details;}
  else{close();pinned=details;details.setAttribute('data-info-open','');details.open=true;}
 },true);
 root.addEventListener('pointerover',event=>{
  if(event.pointerType!=='mouse')return;
  const details=event.target.closest?.(infoDetails);if(!details||!isInfoIcon(details))return;
  if(pinned&&pinned!==details)return;
  clearTimeout(leaveTimer);
  if(details.contains(event.relatedTarget)||details.open)return;
  clearTimeout(hoverTimer);hoverTimer=setTimeout(()=>{if(details.isConnected){details.setAttribute('data-info-open','');details.open=true;}},active?0:240);
 });
 root.addEventListener('pointerout',event=>{
  if(event.pointerType!=='mouse')return;
  const details=event.target.closest?.(infoDetails);if(!details||!isInfoIcon(details)||details.contains(event.relatedTarget))return;
  clearTimeout(hoverTimer);clearTimeout(leaveTimer);
  leaveTimer=setTimeout(()=>{if(active===details&&pinned!==details&&!details.contains(document.activeElement))close();},180);
 });
 root.addEventListener('keydown',event=>{if(event.key==='Escape'&&active){event.preventDefault();event.stopPropagation();const summary=active.querySelector('summary');close();summary?.focus({preventScroll:true});}});
 root.addEventListener('toggle',event=>{
  const details=event.target;if(!(details instanceof Element))return;
  if(details.matches('.ui-info-popover[popover]')){
   if(event.newState==='closed'){
    const owner=details.closest(infoDetails);
    if(owner){owner.open=false;owner.removeAttribute('data-info-open');owner.querySelector('summary')?.setAttribute('aria-expanded','false');if(active===owner)active=null;if(pinned===owner)pinned=null;}
   }
   return;
  }
  if(!details.matches(infoDetails))return;
  if(!details.open){if(active===details)close();return;}
  const summary=details.querySelector('summary'),panel=[...details.children].find(el=>el!==summary);
  if(!summary||!panel?.showPopover)return;
  if(active&&active!==details)close();active=details;
  // Manual dismissal keeps a hover-open panel from closing when its trigger is clicked.
  panel.classList.add('ui-info-popover');panel.popover='manual';panel.id||='ui-info-'+(++identity);
  panel.setAttribute('role','note');panel.setAttribute('aria-label',summary.getAttribute('aria-label')||summary.textContent);
  summary.setAttribute('aria-controls',panel.id);summary.setAttribute('aria-expanded','true');
  details.setAttribute('data-info-open','');
  if(!panel.matches(':popover-open'))panel.showPopover();
  const position=infoPopoverPosition(summary.getBoundingClientRect(),panel.getBoundingClientRect(),{width:window.innerWidth,height:window.innerHeight});
  Object.assign(panel.style,{inset:'auto',left:position.left+'px',top:position.top+'px'});
 },true);
 root.addEventListener('scroll',event=>{if(active&&!active.querySelector('.ui-info-popover')?.contains(event.target))close();},true);
 root.addEventListener('close',event=>{if(active?.closest('dialog')===event.target)close();},true);
 root.addEventListener('hive:locale',close);window.addEventListener('resize',close);
 return close;
}

// Display-only vocabulary. Never rewrite stored events, task keys or action attributes.
const phrases=[
 ['复盘口径','查看统计方式'],['核对口径','记录怎么算'],['费用口径','费用算法'],['信号 / 实例','信号 / 交易'],['保留委托','已记录订单'],['有成交的委托','已有成交'],['委托记录','订单记录'],['执行事件流','交易动态'],['账户权益','总资产'],['权益净变化','资产增减'],['持仓估值','持仓价值'],['本次模拟权益','总资产变化'],['权益变动拆解','资产变化怎么算'],['初始权益','起始资产'],['当前权益','当前资产'],

 ['当前授权不能接管','当前设置还不能交易'],['按授权接管','按设置处理'],['已有实例未结束','还有任务未结束'],['（冻结原版）',''],['内置演练','内置方案'],
 ['策略核验','策略检查'],['执行权限','交易方式'],['当前实例','正在运行'],['运行实例','策略运行'],['模拟实例','本机交易'],
 ['交互演练通过','检查通过'],['演练未通过','还未通过检查'],['演练通过','检查通过'],['待演练','待检查'],['演练中','检查中'],['重新演练','重新检查'],
 ['回执未知 · 待对账','交易结果待确认'],['回执未知','交易结果待确认'],['未知回执','未确认的交易'],['回执异常','交易确认异常'],
 ['账户名义敞口上限','整个账户最多用'],['策略敞口上限','这套策略最多用'],['已成交敞口','已买入金额'],['单笔名义','单笔金额'],
 ['深度核验','深入研究'],['账户私有复核','启动前账户检查'],['交叉核验','交叉检查'],['风险待核验','风险待确认'],
 ['预检通过','检查通过'],['执行预检','启动前检查'],['预检状态','检查状态'],['已阻断','暂不能继续'],['接管','处理机会'],['阻断原因','为什么暂不能交易'],
 ['暂停新增风险','暂停买入'],['暂停新开仓','暂停买入'],['已停新增','已暂停买入'],['处置','处理'],['核验','检查'],['敞口','持仓金额'],
 ['准入','交易前检查'],['回执','结果确认'],['预检','启动前检查'],['裁定','处理'],['在途委托','未完成订单'],['在途','处理中'],
 ['私有复核','账户检查'],['复核','检查'],['待对账','待确认'],['预留','暂占'],['释放','退回'],['交易盘口','交易市场'],
 ['Unknown receipt','Awaiting trade confirmation'],['Precheck passed','Checks passed'],['Current run','Running now'],['Active run','Strategy activity'],
 ['Pause takeover','Pause automatic start'],['Ready to take over','Ready for the next opportunity'],['Cannot take over','Not ready to trade'],
];
export function friendlyText(text){return getLocale()==='zh'?phrases.reduce((s,[from,to])=>s.replaceAll(from,to),String(text??'')):t(String(text??''));}

export const HELP={
 fillCount:[['为什么成交记录比订单多？','Why are there more fills than orders?'],['一笔订单可以分批成交。这里每条记录对应一次已确认成交；订单数单独统计。','One order can fill in parts. Each fill is a confirmed execution; orders are counted separately.']],
 riskPolicy:[['风控策略和金额上限有什么不同？','How is a risk strategy different from a spending limit?'],['金额上限控制最多投入多少。搭配 Astarter 资金保护后，模拟交易还会根据资金回落和利润留存等规则调整新买入。此页的情景预览独立运行，不会修改已有交易。','The allocation limit caps how much you can invest. With Astarter capital protection, simulated entries also respond to drawdowns and profit reserves. Preview scenarios on this page run separately and do not change existing trades.']],
 check:[['策略检查','Strategy check'],['检查设置、可用资金和数据是否齐全。通过后可以进入模拟交易；不代表测出了收益，也不保证能赚钱。','Checks settings, available funds and required data. Passing enables simulation; it is not a backtest or a promise of profit.']],
 capital:[['最多可以用多少钱？','How much can the strategy use?'],['单笔金额控制每次买入；策略上限控制这套策略最多使用的资金；账户上限是整个账户的总限制。每次买入都必须同时满足这些限制。','The per-order amount limits each buy. The strategy limit caps its total allocation, and the account limit caps the whole account. Every buy must satisfy all three.']],
 loss:[['什么时候暂停买入？','When do new buys pause?'],['达到这个金额后暂停新的买入，已有持仓不会自动消失，仍可卖出。本样片按持续模拟会话累计损失，目前只有手续费产生损失，不会每天自动清零。','New buys pause at this amount; existing positions remain and can still be sold. This demo accumulates losses across the ongoing simulation session. Only fees produce losses, with no automatic daily reset.']],
 credits:[['积分怎么用？','How do credits work?'],['收费研究先预留积分，完成后结算，未交付的退回。自动研究达到上限会暂停，手动研究每次单独确认。积分不是交易本金，不影响已有持仓的退出与保护。','Paid research reserves credits, settles on delivery and releases undelivered work. Limits pause automatic research; manual tasks are confirmed separately. Credits are not trading capital and do not stop exits or protection.']],
 protection:[['持仓保护确认了什么？','What does protection status mean?'],['只有已收到确认的数量才算已保护。等待确认或异常时暂停新的买入，已有持仓仍需关注。本页展示模拟状态，未连接真实交易所。','Only confirmed quantities count as protected. Pending or failed protection pauses new buys; keep watching existing positions. These are simulated states, with no live exchange connection.']],
 unknown:[['还没收到交易结果怎么办？','What if a trade is not confirmed?'],['先查询原交易，不要重复下单。结果未确认不代表没有成交；相关资金会继续暂占，直到结果查清。查询本身不会创建新订单。','Check the original trade instead of submitting another. An unconfirmed result does not mean nothing filled; funds remain held until resolved. Checking never creates another order.']],
 fees:[['手续费怎么算？','How are fees calculated?'],['本样片按已成交金额的 0.10% 计算手续费，未成交部分不收费。费用确认可能晚于成交；最终以交易记录为准。','The demo charges 0.10% of filled value. Unfilled quantities incur no fee. Fee confirmation can arrive after a fill; use the trade record as the final source.']],
 performance:[['这些数字是实际收益吗？','Are these real returns?'],['不是。这里使用模拟资金、价格和成交。买卖金额不等于收益；资产变化要连同持仓与手续费一起看。','No. Funds, prices and fills are simulated. Trade value is not profit; evaluate asset changes together with open positions and fees.']],
 funding:[['资金费率是什么？','What is a funding rate?'],['永续合约多空双方定期支付的费用。正值通常是多方向空方付费，负值相反；不是价格涨跌预测。这里显示 8 小时模拟费率，不是你的账户费用。','Periodic payments between long and short perpetual positions. Positive rates usually mean longs pay shorts, and negative rates reverse that. This is an 8-hour demo rate, not a price forecast or your account fee.']],
 oi:[['合约持仓是什么？','What is open interest?'],['市场上尚未平仓的合约总规模，不是你的个人仓位，也不代表资金净流入。结合价格和成交量一起看；这里是模拟市场快照。','The total size of open contracts in a market, not your personal position or net capital inflow. Read it alongside price and volume. These figures are a demo snapshot.']],
 liquidation:[['清算额是什么？','What are liquidations?'],['杠杆仓位因保证金不足而被强制平仓的金额。这里统计模拟 24 小时窗口内的市场总额，不是你的亏损。','The value of leveraged positions forcibly closed for insufficient margin. This is a simulated 24-hour market total, not your personal loss.']],
 freshness:[['数据更新到什么时候？','How recent is the data?'],['页面使用固定模拟样本。图表在动不等于正在接收实时行情；样本时间和统计窗口会在图表附近标明。','This page uses fixed demo samples. Moving charts do not mean live market data is connected. Sample timestamps and measurement windows are shown beside the chart.']],
 chain:[['链上异动代表什么？','What does on-chain activity tell us?'],['转账只能说明资产发生了移动，不能直接当作买入、卖出或某个人的操作。需要继续检查交易类型和来源，才会交给策略判断。','A transfer shows that assets moved. It does not by itself prove a buy, a sell or a person’s intent. Transaction type and source need checking before a strategy can act.']],
 copy:[['跟随会照单全收吗？','Does following copy every action?'],['不会。只有符合你保存的金额、时效、价格偏差和风险限制的交易才会进入模拟。普通转账、重复或过期记录会跳过；卖出只处理这套跟随持有的部分。','No. Only trades within saved size, age, price-gap and risk limits enter simulation. Transfers, duplicate and stale records are skipped. Sells apply only to holdings owned by this copy strategy.']],
 rewards:[['贡献就会获得奖励吗？','Does contributing earn a reward?'],['保存后进入待审核记录，不会立即发积分或奖励。当前只演示提交流程，奖励资格和规则还未上线。','Saving creates a pending review record. It does not immediately award credits or rewards. This demo only covers submission; reward eligibility and rules are not live.']],
 mode:[['自动处理到哪一步？','What can automatic mode do?'],['只观察与提醒不会下单。AI BOT 先批准整份方案，再按已批准规则运行；重要修改须重新批准。AI 自主决策不得超出授权范围。当前交易仅为本地模拟；旧版逐笔确认设置需更新，不会自动获得新授权。','Observe and alert creates no orders. Approve the full AI BOT plan before it runs the approved rules; material changes need renewed approval. Autonomous AI decisions must stay within the authorized scope. Execution is local simulation only. Legacy per-order approval settings need updating; they receive no new authorization automatically.']],
};
export function infoButton(key){const h=HELP[key];if(!h)return '';return `<button type="button" class="ux-info" data-info="${key}" aria-label="${e(L('了解：','About: ')+L(...h[0]))}" aria-haspopup="dialog"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5"/><circle class="ux-info-dot" cx="10" cy="6" r=".8"/></svg></button>`;}
export function helpContent(key){const h=HELP[key];return h?{title:L(...h[0]),body:`<div class="ux-help-body" data-localized-ui><p>${e(L(...h[1]))}</p></div>`}:null;}

const helpLabels=[
 ['check',/^(策略检查|检查状态|本次检查|Strategy check|Precheck|Checks passed)$/],
 ['capital',/^(单笔金额|这套策略最多用|整个账户最多用|账户上限|资金上限|Strategy allocation|Account allocation|Account limit|Per order)(\s*\/\s*USDT)?$/],
 ['loss',/^(累计亏损暂停线|累计模拟损失上限|Simulation loss limit)(\s*\/\s*USDT)?$/],
 ['credits',/^(还能用|可用积分|每日上限|每日研究积分|自动研究每日上限|处理中暂占|先暂占|Actual credits|Held credits|Daily limit|Daily research credits|Daily automatic research limit|Available credits|Held for running tasks)$/],
 ['protection',/^(持仓与保护|Position & protection)$/],
 ['fees',/^(手续费|已记手续费|累计费用|累计手续费|Fee|Recorded fees|Total fees|Fees)(\s*[·/]\s*USDT)?$/],
 ['funding',/^(资金费率均值|资金费率 · 8h|Mean funding rate|Funding · 8h)$/],
 ['oi',/^(合约持仓|加密合约持仓|持仓变化|Open interest|Crypto open interest|OI change)$/],
 ['liquidation',/^(24h 清算额|清算 · 24h|24h liquidations|Liquidations · 24h)$/],
 ['freshness',/^(窗口变化|Window change|模拟快照|Simulation snapshot)$/],
 ['performance',/^(总资产|资产增减|资产净值|账户净值|净收益|Equity|Equity change|Net equity|Net P&L)$/],
 ['copy',/^(跟随规则|跟随谁，怎么跟？|Copy rules|Who to follow, and how\?)$/],
 ['rewards',/^(奖励怎么来？|How would rewards work\?)$/],
 ['chain',/^(AI 与链上追踪|AI & on-chain tracking)$/],
 ['mode',/^(执行模式|处理方式|交易方式|Handling mode|Execution mode|Trading mode)$/],
];
let fieldIdentity=0;
export function enhanceProductCopy(root){
 // Explicit association survives the extra, independently focusable help button.
 for(const label of root.querySelectorAll('label.p-field')){
  const control=label.querySelector('input,select,textarea');if(!control)continue;
  if(!control.id)control.id='hive-field-'+(++fieldIdentity);
  label.htmlFor=control.id;
 }
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
 while((node=walker.nextNode())){
  if(node.parentElement.closest('script,style,code,pre,svg,option,textarea,[data-info],[data-no-translate]'))continue;
  // Full technical evidence remains available within disclosure sections.
  if(node.parentElement.closest('details')&&!node.parentElement.closest('summary'))continue;
  const next=friendlyText(node.nodeValue);if(next!==node.nodeValue)node.nodeValue=next;
 }
 for(const el of root.querySelectorAll('h1,h2,h3,dt,th,label.p-field,.p-stats>div>span,.metric-row>div>span,.ux-metrics>div>span,.biz-stats>div>span,.ux-market-summary>div>span')){
  if(el.querySelector('[data-info],'+infoDetails)||el.closest('header.ui-info-header')?.querySelector('[data-ui-info]')||(el.closest('button,summary')||(el.closest('details')&&!el.matches('label.p-field'))))continue;
  const title=[...el.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim();
  const key=helpLabels.find(([,pattern])=>(pattern.test(title)||pattern.test(translate(title,'en'))))?.[0];
  if(!key)continue;
  const input=el.querySelector('input,select');
  if(input){
   if(el.matches('label.p-field')&&!input.hasAttribute('aria-label')&&!input.hasAttribute('aria-labelledby'))input.setAttribute('aria-label',title);
   input.insertAdjacentHTML('beforebegin',infoButton(key));
  }else el.insertAdjacentHTML('beforeend',infoButton(key));
 }
}
