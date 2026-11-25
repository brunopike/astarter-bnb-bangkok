import {pair as L} from './locale.mjs';
import {tradingChartPanel,formatTradingPrice} from './trading-chart.mjs';
import {uiGlyph} from './product-composition.mjs';
import {formatDataTime} from './product-help.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {CATALOG} from './strategy-catalog.mjs';
import {BOT_MARKETS,isBotSimulation} from './bot-runtime.mjs';
import {protectionValid} from './strategy-protection.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=value=>Number(value||0).toLocaleString('en-US',{maximumFractionDigits:2});
const known=new Set(CATALOG.map(s=>s.id));
const eventTime=item=>Number(item.recordedAt)||0;
const orderStatus=value=>({filled:L('已成交','Filled'),partial:L('部分成交','Part filled'),submitted:L('处理中','Pending'),unknown:L('待确认','Unconfirmed'),rejected:L('订单被拒绝','Rejected'),cancelled:L('已撤销','Cancelled'),'partial-cancelled':L('部分成交后撤销','Part filled, cancelled')})[value]||value;

export function botProtectionRows(plan){
 const policy=plan.protection;
 if(policy?.id!=='astarter'||!policy.parameters||!protectionValid(policy))return [];
 return [['episode','单轮风险上限','Risk per cycle'],['notional','单笔投入上限','Order allocation limit'],['daily','单日亏损暂停','Daily loss pause'],['epoch','风险期预算','Risk-period budget'],['soft','回撤降档','Drawdown reduction'],['hard','回撤暂停','Drawdown pause']].map(([key,zh,en])=>[L(zh,en),(policy.parameters[key]*100).toLocaleString('en-US',{maximumFractionDigits:6})+'%']);
}
export function botParameterRows(plan){
 if(!isBotSimulation(plan))return [];
 const p=plan.botParameters||{},precise=value=>Number(value||0).toLocaleString('en-US',{maximumFractionDigits:20}),price=value=>value===undefined||value===''?'—':precise(value),pct=value=>value===undefined||value===''?'—':esc(value)+'%';
 const rows=plan.strategy==='S01'?[
  [L('价格区间','Price range'),`${price(p.lower)} – ${price(p.upper)} USDT`],
  [L('网格数量','Grid count'),esc(p.count??'—')+' · '+L(p.spacing==='geometric'?'等比':'等差',p.spacing==='geometric'?'Geometric':'Arithmetic')],
  [L('每格买入金额','Amount per grid'),precise(plan.amount)+' USDT'],
  [L('止盈价 / 止损价','Take-profit / stop-loss price'),price(p.takeProfitPrice)+' / '+price(p.stopLossPrice)],
  [L('触发价格','Trigger price'),price(p.triggerPrice)]
 ]:[
  [L('加仓间距','Entry deviation'),pct(p.deviationPct)],
  [L('买入金额倍率','Entry size multiplier'),esc(p.sizeMultiplier??'—')+'×'],
  [L('最多买入次数','Maximum entries'),esc(p.maxEntries??'—')],
  [L('首笔买入金额','Initial entry amount'),precise(plan.amount)+' USDT'],
  [L('整篮止盈 / 止损','Basket take-profit / stop-loss'),pct(p.takeProfitPct)+' / '+pct(p.stopLossPct)],
  [L('触发价格','Trigger price'),price(p.triggerPrice)]
 ];
 return rows.concat(botProtectionRows(plan));
}
export function botParameterFacts(plan){return `<dl class="bot-parameter-facts">${botParameterRows(plan).map(([name,value])=>`<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl>`;}

export function botParameterFields(plan,source='recommended',referencePrice=null){
 const p=plan.botParameters||{},currency=plan.market?.split('/')[1]||'USDT';
 const field=(key,zh,en,{min='0.00000001',max='',step='any',unit='',optional=false}={})=>`<label class="sc-field bot-parameter-field">${L(zh,en)}<span><input name="bot_${key}" data-bot-parameter="${key}" aria-label="${L(zh,en)}" type="number" inputmode="${step===1?'numeric':'decimal'}" min="${min}" ${max?`max="${max}"`:''} step="${step}" ${optional?'':'required'} value="${esc(p[key]??'')}">${unit?`<b>${esc(unit)}</b>`:''}</span></label>`;
 const grid=plan.strategy==='S01';
 return `<section class="bot-parameter-editor"><div class="bot-config-tabs" role="tablist" aria-label="${L('参数来源','Parameter source')}">${[['recommended','推荐参数','Recommended'],['manual','手动设置','Manual']].map(([id,zh,en])=>`<button type="button" role="tab" aria-selected="${source===id}" data-sc="parameter-source" data-id="${id}">${L(zh,en)}</button>`).join('')}</div>${source==='recommended'?`<div class="bot-recommendation"><div><small>${L('参考价','Reference price')} ${Number.isFinite(referencePrice)&&referencePrice>0?formatTradingPrice(referencePrice)+' '+esc(currency):'—'}</small></div><p>${L(Number.isFinite(referencePrice)&&referencePrice>0?'按所选资产的行情生成，可手动调整。':'等待所选资产的行情，或切换手动设置。',Number.isFinite(referencePrice)&&referencePrice>0?'Based on the selected market. You can adjust these values.':'Wait for the selected market, or enter parameters manually.')}</p><button class="sc-link" type="button" data-sc="apply-bot-parameters" ${Number.isFinite(referencePrice)&&referencePrice>0?'':'disabled'}>${uiGlyph('refresh')}<span>${L("应用推荐","Use suggested")}</span></button></div>`:''}<fieldset class="bot-native-fields" ${plan.market?'':'disabled'}><legend>${L(grid?'网格参数':'买入计划',grid?'Grid parameters':'Entry plan')}</legend>${grid?`<div class="bot-parameter-pair">${field('lower','最低价格','Lower price',{unit:currency})}${field('upper','最高价格','Upper price',{unit:currency})}</div><div class="bot-parameter-pair">${field('count','网格数量','Grid count',{min:2,max:100,step:1})}<label class="sc-field">${L('网格类型','Grid spacing')}<select name="bot_spacing" data-bot-parameter="spacing"><option value="arithmetic" ${p.spacing!=='geometric'?'selected':''}>${L('等差','Arithmetic')}</option><option value="geometric" ${p.spacing==='geometric'?'selected':''}>${L('等比','Geometric')}</option></select></label></div>`:`<div class="bot-parameter-pair">${field('deviationPct','加仓间距','Entry deviation',{max:99.99,unit:'%'})}${field('sizeMultiplier','买入金额倍率','Entry size multiplier',{min:1,max:10,unit:'×'})}</div>${field('maxEntries','最多买入次数','Maximum entries',{min:1,max:3,step:1})}`}<details class="bot-native-advanced"><summary>${L("触发、止盈与止损","Trigger, take-profit & stop-loss")}${uiGlyph('chevron')}</summary>${field('triggerPrice','触发价格','Trigger price',{unit:currency,optional:true})}<small>${L('留空立即开始模拟；填写后等待纸面价格触发。','Leave blank to start immediately, or wait for the paper price trigger.')}</small><div class="bot-parameter-pair">${grid?field('takeProfitPrice','止盈价格','Take-profit price',{unit:currency,optional:true})+field('stopLossPrice','止损价格','Stop-loss price',{unit:currency,optional:plan.protection?.id!=='astarter'}):field('takeProfitPct','整篮止盈','Basket take-profit',{unit:'%',max:1000})+field('stopLossPct','整篮止损','Basket stop-loss',{unit:'%',max:99.99})}</div></details></fieldset></section>`;
}

export function botInstanceStatus(status){return ({waiting:L('等待触发','Waiting for trigger'),running:L('模拟运行中','Simulation running'),paused:L('已暂停买入','Entries paused'),interrupted:L('已中断，待恢复','Interrupted · resume required'),blocked:L('待核对回执','Reconciliation required'),stopping:L('正在结束','Ending'),stopped:L('已结束','Ended'),failed:L('未能启动','Start failed')})[status]||esc(status);}

const botReason=value=>({
 '暂停新买入；原订单与已有库存保留。':L('暂停新买入；原订单与已有库存保留。','New buys are paused; existing orders and holdings remain.'),
 'user-keep':L('用户结束 · 保留持仓','Ended by user · keep holdings'),
 'user-close':L('用户结束 · 卖出持仓','Ended by user · sell holdings'),
 'manual-exit':L('手动退出','Manual exit'),
 'stop-loss':L('触发止损','Stop-loss triggered'),
 'take-profit':L('触发止盈','Take-profit triggered')
})[value]||value;

export function botInstancesView(trade,names,{history=false,endRunId=null}={}){
 const book=trade?.botBook,runs=(book?.runs||[]).filter(run=>history?['stopped','failed'].includes(run.status):!['stopped','failed'].includes(run.status)||Number(run.quantity)>0);
 if(!runs.length)return '';
 const button=(run,label,kind,{primary=false,orderId=''}={})=>`<button type="button" class="sc-button ${primary?'sc-primary':''}" data-sc="bot-action" data-id="${esc(run.id)}" data-kind="${kind}" data-version="${run.plan.version}" data-account="${esc(run.plan.executionRoute.accountId)}" data-connection="${esc(run.plan.executionRoute.connectionId)}" aria-label="${esc(label)} · ${esc(run.id)} · ${esc(run.plan.market)}" ${orderId?`data-order="${esc(orderId)}"`:''}>${label}</button>`;
 return `<section class="bot-instances" data-bot-instances><header class="section-heading"><h2>${L(history?'已结束 Agent':'我的 Agent',history?'Ended Agents':'My Agents')}</h2><span>${runs.length} · DEMO</span></header>${[...runs].reverse().map(run=>{
  const cancellations=(book.residentControl?.cancelRequests||[]).filter(row=>row.runId===run.id&&row.state!=='RECONCILED');
  const plan=run.plan,pnl=Number(run.realizedPnl||0)+Number(run.unrealizedPnl||0),unknown=run.orders.find(order=>order.status==='unknown'||cancellations.some(row=>row.orderId===order.id)),ended=['stopped','failed'].includes(run.status),qty=Number(run.quantity||0),confirm=endRunId===run.id&&!run.endIntent;
  const settled=ended&&qty===0&&run.cash===0&&run.allocated===0&&Array.isArray(book.flow?.reservations)&&!run.orders.some(order=>['submitted','partial','unknown','confirming'].includes(order.status))&&!book.flow.reservations.some(row=>row.state==='HELD'&&(row.instanceId===run.id||run.orders.some(order=>order.id===row.orderId)));
  const clockStart=run.events.find(event=>event.kind==='created'&&Number.isFinite(event.at))?.at;
  const budgetHeld=run.status==='running'&&!run.endIntent&&!unknown&&!cancellations.length&&!trade?.botSummary?.recoveryError&&run.protectionDecision?.scope==='BOT_ALLOCATION'&&run.protectionDecision.action==='pause'&&run.protectionDecision.reason==='budget'&&run.protectionDecision.amount===0;
  const reason=run.endReason||run.pauseReason||(run.status==='paused'?'暂停新买入；原订单与已有库存保留。':'')||(budgetHeld?L('风控后额度不足，暂不新增买入','Risk-adjusted allocation is insufficient; new buys are on hold'):'');
  const controls=ended?qty>0?button(run,L('卖出保留持仓','Sell retained holdings'),'close-position'):'' : `${['running','waiting'].includes(run.status)?button(run,L('暂停买入','Pause entries'),'pause'):['paused','interrupted'].includes(run.status)?button(run,L(run.status==='paused'?'恢复买入':'恢复运行',run.status==='paused'?'Resume entries':'Resume'),'resume'):''}${unknown?button(run,L('查询原订单','Query original order'),'query',{orderId:unknown.id}):''}${run.endIntent?'':`<button type="button" class="sc-button" data-sc="bot-end" data-id="${esc(run.id)}">${L('结束运行','End run')}</button>`}`;
  return `<article class="bot-instance" data-bot-instance="${esc(run.id)}"><header><div class="bot-instance-identity">${tokenIcon(plan.market.split('/')[0],{size:32})}<div><h3>${esc(plan.market)} <span>${esc(names[plan.strategy]||plan.strategy)}</span></h3><small>${esc(run.id)} · ${esc(plan.planVariant)} · v${plan.version} · ${esc(plan.executionRoute.accountId)}</small></div></div><span class="sc-tag ${run.status==='running'?'available':''}">${botInstanceStatus(run.status)}</span></header><div class="bot-instance-metrics">${[[L('模拟盈亏','Simulated PnL'),(pnl>=0?'+':'')+amount(pnl),'USDT'],[ended?L('已返还资金','Returned capital'):L('当前权益','Current equity'),amount(ended?run.returned:run.equity),'USDT'],[ended?L('原始分配','Initial allocation'):L('已分配额度','Allocated capital'),amount(ended?run.initialAllocation:run.allocated),'USDT'],[L('交易费','Fees'),amount(run.fees),'USDT']].map(([label,value,unit],i)=>`<div><span>${label}</span><strong class="${i===0?(pnl<0?'loss':pnl>0?'profit':''):''}">${value}<small>${unit}</small></strong></div>`).join('')}</div>${settled?'':`<div class="bot-instance-balance"><span>${L('可用余额','Available cash')} ${amount(run.freeCash??run.cash)} USDT</span><span>${L('持仓数量','Holding quantity')} ${qty.toLocaleString('en-US',{maximumFractionDigits:8})} ${esc(plan.market.split('/')[0])}</span><span>${L('模拟价格','Paper price')} ${amount(run.markPrice)} USDT</span></div>`}${reason?`<p class="bot-instance-reason">${esc(botReason(reason))}</p>`:''}${cancellations.length?`<p class="bot-instance-reason" role="status">${L('正在核对原订单，确认前资金继续保留；无需重复结束。','Reconciling the original order. Capital stays reserved until confirmed; do not end again.')}</p>`:''}${confirm?`<section class="bot-end-confirm" role="group" aria-label="${L("确认结束运行","Confirm end of run")}"><h4>${L('结束后怎样处理持仓？','What happens to holdings when ending?')}</h4><p>${L('停止新买入并核对未完成订单；保留持仓，或卖出后结束。','Stop new buys and reconcile pending orders. Keep simulated holdings, or wait for the sell order to fill.')}</p><div>${button(run,L('结束并留仓','End & keep holdings'),'stop-keep')}${button(run,L('结束并卖出','End & sell'),'stop-close',{primary:true})}<button class="sc-button" type="button" data-sc="bot-end-cancel">${L('取消','Cancel')}</button></div></section>`:''}<details class="bot-instance-details" data-persist-key="bot-instance-${esc(run.id)}"><summary>${L('原批准参数与运行记录','Approved parameters & activity')}${uiGlyph('chevron')}</summary><div class="bot-approved-plan"><span>${esc(plan.id)} · v${plan.version} · ${esc(plan.executionRoute.connectionId)} · DEMO</span>${botParameterFacts(plan)}<p>${L('资金保护','Protection')} · ${plan.protection?.id==='astarter'?'Astarter · '+L(plan.protection.mode==='conservative'?'保守':'正常',plan.protection.mode==='conservative'?'Conservative':'Normal'):L('原有策略保护','Original strategy protection')}</p><p>${L('原始分配 / 已返还','Initial allocation / returned')} ${amount(run.initialAllocation)} / ${amount(run.returned)} USDT</p></div><div class="bot-history-orders">${run.orders.length?`<table><thead><tr>${[L('订单','Order'),L('操作','Action'),L('状态','Status'),L('成交数量','Filled quantity'),L('成交价格','Price'),L('交易费','Fees')].map(name=>`<th>${name}</th>`).join('')}</tr></thead><tbody>${run.orders.map(order=>`<tr><td>${esc(order.id)}</td><td>${order.side==='buy'?L('买入','Buy'):L('卖出','Sell')}</td><td>${esc(cancellations.some(row=>row.orderId===order.id)?L('撤单待确认','Cancellation unconfirmed'):orderStatus(order.status))}</td><td>${(Number(order.qty)*Number(order.filled)).toLocaleString('en-US',{maximumFractionDigits:8})}</td><td>${amount(order.price)}</td><td>${amount(order.fee)}</td></tr>`).join('')}</tbody></table>`:`<p>${L('本轮没有成交订单。','No orders were filled in this run.')}</p>`}</div><ol class="bot-instance-events">${[...(run.events||[])].reverse().map(event=>`<li><time>${Number.isFinite(clockStart)&&Number.isFinite(event.at)&&event.at>=clockStart?'+'+(event.at-clockStart).toFixed(1)+'s · SIM':L('模拟时点','SIM time')+' '+(Number.isFinite(event.at)?event.at.toFixed(1)+'s':'—')}</time><span>${esc(botReason(event.reason||event.text))}</span></li>`).join('')}</ol></details><footer><small>${L('独立纸面模拟','Independent paper simulation')}</small><div>${controls}<button type="button" class="sc-button" data-sc="bot-reuse" data-id="${esc(run.id)}">${L('复制参数','Copy parameters')}</button></div></footer></article>`;
 }).join('')}</section>`;
}

export function botRunHistory(trade){
 const runs=new Map();
 for(const item of [...(trade?.events||[]),...(trade?.orders||[])]){
  if(!item.runId||!known.has(item.strategy))continue;
  if(!runs.has(item.runId))runs.set(item.runId,{id:item.runId,strategy:item.strategy,market:item.market,at:0,orders:[],fees:0,notional:0});
  const run=runs.get(item.runId);run.at=Math.max(run.at,eventTime(item));
 }
 for(const order of trade?.orders||[]){const run=runs.get(order.runId);if(!run)continue;run.orders.push(order);run.fees+=Number(order.fee)||0;run.notional+=(Number(order.filled)||0)*(Number(order.qty)||0)*(Number(order.price)||0);}
 for(const run of runs.values()){run.current=trade.session?.id===run.id;run.state=run.current?trade.state:'stopped';}
 return [...runs.values()].sort((a,b)=>b.at-a.at);
}

export function botManagementSummary(workspace,trade){
 const watching=Boolean(trade?.discovery?.armed),active=watching||Boolean(trade?.session&&!trade.session.singleShot&&trade.state!=='stopped');
 const history=botRunHistory(trade),fees=history.reduce((sum,run)=>sum+run.fees,0)+Number(trade?.botSummary?.fees||0);
 const watched=watching?workspace.s.drafts.find(d=>d.id===trade.discovery.draftId&&d.version===trade.discovery.version&&d.executionRoute?.connectionId===trade.discovery.connectionId):null,allocation=active?watching?watched?.cap:trade.session?.cap:0;
 return `<section class="bot-management-summary" aria-label="${L("Agent 概览","Agent overview")}">${[[L('运行与等待','Active & watching'),(active?1:0)+Number(trade?.botSummary?.activeCount||0),''],[L('策略总额度','Strategy allocation'),allocation==null?'—':amount(Number(allocation||0)+Number(trade?.botSummary?.allocated||0)),'USDT'],[L("已保存方案","Saved plans"),workspace.s.drafts.length,''],[L("累计交易费","Trading fees"),amount(fees),'USDT']].map(([label,value,unit])=>`<div><span>${label}</span><strong>${value}${unit?`<small>${unit}</small>`:''}</strong></div>`).join('')}</section>`;
}

export function botRunStats(draft,trade){
 if(trade?.session?.draftId!==draft.id)return '';
 const orders=(trade.orders||[]).filter(order=>order.runId===trade.session.id),fills=orders.filter(order=>Number(order.filled)>0);
 return `<div class="bot-run-stats"><span>${L('成交订单','Filled orders')}<b>${fills.length}</b></span><span>${L('交易费','Fees')}<b>${amount(orders.reduce((sum,order)=>sum+(Number(order.fee)||0),0))} USDT</b></span><span>${L('待处理订单','Pending orders')}<b>${orders.filter(order=>['submitted','partial','unknown','confirming'].includes(order.status)).length}</b></span></div>`;
}

export function botHistoryView(trade,names){
 const runs=botRunHistory(trade),native=botInstancesView(trade,names,{history:true});
 if(!runs.length)return native|| `<div class="bot-history-empty">${uiGlyph('history')}<h3>${L('运行记录会保存在这里','Your runs will appear here')}</h3><p>${L('启动策略后，可查看每轮的成交与费用。','Start a strategy to review each run’s fills and fees.')}</p></div>`;
 return native+`<div class="bot-history-list">${runs.map(run=>`<details class="bot-history-row" data-bot-history="${esc(run.id)}"><summary><span class="bot-history-market">${tokenIcon(run.market?.split('/')[0]||'BTC',{size:27})}<span><b>${esc(run.market||'—')}</b><small>${esc(names[run.strategy]||run.strategy)}</small></span></span><span class="bot-history-state">${run.current&&run.state!=='stopped'?L('本轮运行','Current run'):L('已结束','Ended')}</span><span><small>${L('成交金额','Filled value')}</small><b>${amount(run.notional)} USDT</b></span><span><small>${L('交易费','Fees')}</small><b>${amount(run.fees)} USDT</b></span><time>${run.at?formatDataTime(run.at):'—'}</time>${uiGlyph('chevron')}</summary><div class="bot-history-orders">${run.orders.length?`<table><thead><tr>${[L('操作','Action'),L('状态','Status'),L('成交数量','Filled quantity'),L('成交价格','Price'),L('交易费','Fees')].map(label=>`<th>${label}</th>`).join('')}</tr></thead><tbody>${run.orders.map(order=>`<tr><td>${order.side==='buy'?L('买入','Buy'):L('卖出','Sell')}</td><td>${esc(orderStatus(order.status))}</td><td>${(Number(order.qty||0)*Number(order.filled||0)).toLocaleString('en-US',{maximumFractionDigits:8})}</td><td>${amount(order.price)}</td><td>${amount(order.fee)} USDT</td></tr>`).join('')}</tbody></table>`:`<p>${L('本轮没有成交订单。','No orders were filled in this run.')}</p>`}</div></details>`).join('')}</div>`;
}

export function botTemplateOverview({art,description,entry,exit,scope,timeframe,reference,ready,need,version}){
 return `<section class="bot-template-overview"><div class="bot-template-visual">${art}</div><div class="bot-template-summary"><h3>${esc(description)}</h3><dl><div><dt>${L('适用范围','Scope')}</dt><dd>${esc(scope)}</dd></div><div><dt>${L('观察周期','Timeframe')}</dt><dd>${esc(timeframe)}</dd></div><div><dt>${L('当前版本','Version')}</dt><dd>${esc(String(version).split("@").pop())}</dd></div></dl><p class="bot-template-next">${ready?L('设置金额与保护后，AI 会等待符合规则的机会。','Set your allocation and protection. AI then waits for a matching opportunity.'):L('可以保存这套规则，供研究和后续配置使用。','Save these rules for research and later configuration.')}</p></div><details class="bot-template-rules"><summary>${L("入场、退出与数据","Entry, exit & data")}${uiGlyph('chevron')}</summary><div><h4>${L('买入规则','Entry rules')}</h4><p>${esc(entry)}</p><h4>${L('退出规则','Exit rules')}</h4><p>${esc(exit)}</p><h4>${L('数据与执行要求','Data and execution requirements')}</h4><p>${esc(need)}</p><dl><div><dt>${L(ready?'演练示例':'研究基准',ready?'Rehearsal example':'Research reference')}</dt><dd>${esc(reference)}</dd></div></dl></div></details></section>`;
}

export function botCreationFrame({content,period='1H',view='quick',mobileView='settings',limit=null,entry,exit,market='',profileId='cex-spot',venueId='binance',strategyId='',nativeBot=false,chartIdentity=null,gridPlan=null,planRef=null,embedded=null}){
 const currency=market.split('/')[1]||'USDT';
 const chart=market?tradingChartPanel('strategy-create-market',{market,period,profileId,venueId,gridPreview:strategyId==='S01'&&!nativeBot,identity:chartIdentity,gridPlan,planRef,instrumentPicker:embedded?.instrumentPicker===true}):(embedded?.empty??`<div class="bot-market-empty">${embedded?.art?`<div class="bot-market-mechanism">${embedded.art}</div>`:uiGlyph('chart')}<h3>${L('选择交易资产','Choose an instrument')}</h3><p>${L('行情与规则预览会跟随你的选择','The chart follows your selected instrument')}</p>${embedded?`<button type="button" class="sc-button" data-sc="choose-instrument">${L('选择交易资产','Choose an instrument')}</button>`:''}</div>`);
 const rules=embedded?.details??`<details class="bot-creation-rules"><summary>${L('这套策略怎样买入和退出','How this strategy enters and exits')}${uiGlyph('chevron')}</summary><h4>${L('买入','Entry')}</h4><p>${esc(entry)}</p><h4>${L('退出','Exit')}</h4><p>${esc(exit)}</p></details>`;
 const controls=['quick','full'].includes(view)?`<div class="bot-config-tabs" role="tablist" aria-label="${L('设置方式','Configuration view')}">${[['quick','快速配置','Quick setup'],['full','完整设置','Full settings']].map(([id,zh,en])=>`<button type="button" role="tab" aria-selected="${view===id}" data-sc="config-view" data-id="${id}">${L(zh,en)}</button>`).join('')}</div><div class="bot-allocation-shortcuts"><span>${L('可分配额度','Available allocation')} <b>${limit===null?'—':amount(limit)+' '+esc(currency)}</b></span><div>${[.25,.5,.75,1].map(fraction=>`<button type="button" data-sc="allocation" data-id="${fraction}" ${limit===null?'disabled':''}>${fraction*100}%</button>`).join('')}</div></div>`:'';
 const settings=controls+content;
 return `<div class="bot-creation-workspace" data-config-mode="${view||'review'}" data-mobile-view="${mobileView}"><nav class="bot-mobile-tabs" aria-label="${L('创建工作区','Creation workspace')}">${[['settings','设置','Settings'],['market','行情','Market']].map(([id,zh,en])=>`<button type="button" data-sc="mobile-view" data-id="${id}" aria-pressed="${mobileView===id}">${L(zh,en)}</button>`).join('')}</nav><section class="bot-creation-market">${chart}${rules}</section><section class="bot-creation-settings">${embedded?`${embedded.header||''}<div class="bot-settings-scroll">${settings}</div>${embedded.footer||''}`:settings}</section></div>`;
}
