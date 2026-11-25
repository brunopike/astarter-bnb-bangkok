import {PROFILES,PLANS} from './commerce-catalog.mjs';
import {L} from './execution-views.mjs';
export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money=cents=>new Intl.NumberFormat(L('zh-CN','en-US'),{style:'currency',currency:'USD',currencyDisplay:'narrowSymbol',maximumFractionDigits:cents%100?2:0}).format(cents/100);
export const date=(time,withTime=false)=>time?new Intl.DateTimeFormat(L('zh-CN','en-GB'),{timeZone:'Asia/Shanghai',year:'numeric',month:'short',day:'numeric',...(withTime?{hour:'2-digit',minute:'2-digit',hour12:false}:{})}).format(time):'—';
export const billingLabel=interval=>({monthly:L('月付','Monthly'),quarterly:L('季付','Quarterly'),yearly:L('年付','Yearly'),legacy:L('30 天','30 days')}[interval]||L('30 天','30 days'));
export const scopeName=s=>s.scopeType==='personal'||s.type==='personal'?L('个人工作区','Personal workspace'):s.scopeName||s.name||'Team';
const contextId=value=>typeof value==='string'&&value.length<=80&&/^[\w][\w:.-]*$/.test(value)&&!/^(?:sk[-_]|rk[-_]|AIza|gh[pousr]_)|^(?:0x)?[a-f\d]{64}$/i.test(value)?value:'';
export function commerceContext(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const context={};for(const key of ['taskId','runId','ref']){if(value[key]===undefined||value[key]===null||value[key]==='')continue;const id=contextId(value[key]);if(!id)return null;context[key]=id;}
 return Object.keys(context).length?context:null;
}
export function commerceContextLink(value,page='usage'){
 const context=commerceContext(value);if(!context)return null;
 const query=new URLSearchParams({page:page==='billing'?'billing':'usage'});
 for(const [key,param]of [['taskId','task'],['runId','run'],['ref','ref']])if(context[key])query.set(param,context[key]);
 return '?'+query.toString();
}
export function contextTasks(tasks,value){
 const context=commerceContext(value);if(!context)return [];
 return tasks.filter(job=>(!context.taskId||job.id===context.taskId)&&(!context.runId||job.input?.runId===context.runId)&&(!context.ref||job.input?.ref===context.ref));
}
export function taskCreditSummary(job){
 if(!job||!['reserved','unknown','complete','cancelled','failed','released'].includes(job.status)||![job.reserved,job.settled].every(n=>Number.isSafeInteger(n)&&n>=0)||job.settled>job.reserved)return null;
 const pending=['reserved','unknown'].includes(job.status),unused=job.reserved-job.settled;
 return {reserved:job.reserved,settled:job.settled,held:pending?unused:0,released:pending?0:unused,pending};
}
export function taskCreditDetails(job){
 const source=({assistant:L('AI 助手','AI assistant'),workbench:L('AI 战队','AI workbench'),'usage-preview':L('用量试算','Usage rehearsal')})[job?.input?.source]||job?.input?.source;
 const summary=taskCreditSummary(job);if(!summary)return `<p class="commerce-callout">${L('费用记录尚未核验，请重新同步；暂不显示为零。','Charges are unconfirmed. Sync again; no zero charge is assumed.')}</p>`;
 return `<dl class="commerce-task-cost">${[['reserved',L('最初预留','Original hold')],['settled',L('已实扣','Settled')],['held',L('仍预留','Still held')],['released',L('已释放','Released')]].map(([key,label])=>`<div><dt>${label}</dt><dd>${summary[key].toLocaleString()} <small>Credit</small></dd></div>`).join('')}</dl>${summary.pending?`<p class="commerce-caption">${L('任务尚未结算，预留余量仍保留。最终费用确认后才会释放。','Settlement is pending. Unused Credits remain held until the final charge is confirmed.')}</p>`:''}<p class="commerce-caption">${L('费用来源','Charge source')} · ${esc(L(PROFILES[job.profile]?.zh||job.profile,PROFILES[job.profile]?.en||job.profile))} · ${job.mode==='auto'?L('自动任务','Automatic task'):L('手动确认','Manual confirmation')}${job.priceVersion?' · '+esc(job.priceVersion):''}${typeof source==='string'?' · '+esc(source.slice(0,120)):''}</p>`;
}
export function commerceStyle(){if(!document.querySelector('link[href="/commerce.css"]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/commerce.css';document.head.append(link);}}
export function modal(title,body,buttons,origin=document.activeElement,variant=''){
 commerceStyle();return new Promise(resolve=>{
  const d=document.createElement('dialog'),titleId='commerce-'+crypto.randomUUID();
  const value=v=>typeof v==='function'?v():v;
  d.className='commerce-flow'+(variant?' '+variant:'');d.setAttribute('aria-labelledby',titleId);
  d.innerHTML=`<header><h2 id="${titleId}">${esc(title)}</h2><button type="button" data-close aria-label="${L('关闭','Close')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="commerce-body">${body}</div><p class="commerce-error" role="alert"></p><footer>${buttons.map(b=>`<button type="button" data-action="${b.id}" ${b.primary?'class="primary"':''} ${value(b.disabled)?'disabled':''}>${esc(value(b.label))}</button>`).join('')}</footer>`;
  document.body.append(d);let done=false,busy=false;
  const finish=value=>{if(done)return;done=true;d.close();d.remove();resolve(value);requestAnimationFrame(()=>{const requested=typeof origin==='function'?origin():origin,target=requested?.isConnected&&!requested.disabled?requested:document.querySelector('.commerce-page h1');target?.focus();});};
  d.querySelector('[data-close]').onclick=()=>{if(!busy)finish(null);};
  d.addEventListener('cancel',e=>{e.preventDefault();if(!busy)finish(null);});
  for(const b of buttons)d.querySelector(`[data-action="${b.id}"]`).onclick=async()=>{
   if(busy)return;busy=true;for(const el of d.querySelectorAll('button'))el.disabled=true;
   d.setAttribute('aria-busy','true');d.querySelector('[role=alert]').textContent='';
   try{const result=b.run?await b.run(d):b.id;if(result!==false)finish(result);}
   catch(e){d.querySelector('[role=alert]').textContent=e.message;}
   finally{busy=false;d.removeAttribute('aria-busy');d.querySelector('[data-close]').disabled=false;for(const choice of buttons){const el=d.querySelector(`[data-action="${choice.id}"]`);el.disabled=!!value(choice.disabled);el.textContent=value(choice.label);}}
  };
  d.showModal();
 });
}
const checkoutFlows=new WeakMap();
export function checkout(account,purchase,existing=null,origin=document.activeElement){
 if(checkoutFlows.has(account))return checkoutFlows.get(account);
 const pending=reviewCheckout(account,purchase,existing,origin).finally(()=>checkoutFlows.delete(account));checkoutFlows.set(account,pending);return pending;
}
async function reviewCheckout(account,purchase,existing,origin){
 let order=existing;
 const quote=await account.command('order-quote',existing?{id:existing.id}:purchase),plan=quote.kind==='plan'?PLANS[quote.product]:null;
 const {cents,credits}=quote,future=plan&&quote.start_at>account.s.now,monthly=plan&&quote.interval!=='legacy';
 const body=`<div class="commerce-checkout-product"><div><h3>${plan?esc(plan.name):L('Credit 充值','Credit top-up')}</h3><p>${plan?billingLabel(quote.interval)+' · '+L('手动续订','Manual renewal'):L('一次充值，永久有效','One-time purchase, no expiry')}</p></div><span class="commerce-checkout-credit"><b>${credits.toLocaleString()}</b> Credit${monthly?'<span>'+L('每月发放','each month')+'</span>':''}</span></div><dl class="commerce-checkout-summary"><div><dt>${L('小计','Subtotal')}${plan?' · '+billingLabel(quote.interval):''}</dt><dd>${money(quote.baseCents)}</dd></div>${quote.discountCents?`<div class="commerce-checkout-discount"><dt>${quote.interval==='quarterly'?L('季付优惠 · 9 折','Quarterly · 10% off'):L('年付优惠 · 7 折','Yearly · 30% off')}</dt><dd>−${money(quote.discountCents)}</dd></div>`:''}<div class="commerce-checkout-total"><dt>${L('本次支付','Total')}</dt><dd class="dot-number">${money(cents)}</dd></div></dl><dl class="commerce-checkout-facts">${plan?`<div><dt>${L('生效日期','Starts')}</dt><dd>${future?date(quote.start_at):L('到账后立即生效','On delivery')}</dd></div><div><dt>${L('有效至','Valid until')}</dt><dd>${date(quote.end_at)}</dd></div><div><dt>${L('Credit 有效期','Credit expiry')}</dt><dd>${monthly?L('每月发放，当期有效','Valid until the next monthly grant'):L('本期有效','This period')}</dd></div>`:`<div><dt>${L('充值后可用','Available after top-up')}</dt><dd>${(account.available+credits).toLocaleString()} Credit</dd></div>`}</dl><p class="commerce-simulation">${L('当前为模拟支付，真实扣款关闭。','Simulated payment. Live charging is off.')}</p>`;
 const title=!plan?L('确认充值','Confirm top-up'):future?plan.id===account.s.plan?L('确认续订','Review renewal'):L('确认下期换档','Review next-period change'):L('确认订阅','Review subscription');
 return modal(title,body,[
  {id:'pay',label:L('模拟支付 ','Simulate payment ')+money(cents),primary:true,run:async()=>{
   // Opening the review reads a quote; only this explicit action creates an order.
   order||=await account.command('order-create',{...purchase,expectedCents:cents,...(plan?{expectedPlanUntil:quote.planUntil}:{})});
   if(order.cents!==cents)throw Error(L('报价已变化，请关闭后重新确认。','The price changed. Close and review it again.'));
   return account.command('order-pay',{id:order.id,...(plan?{expectedPlanUntil:quote.planUntil}:{})});
  }},
  {id:'back',label:L('返回','Back'),run:()=>null}
 ],()=>origin?.isConnected?origin:document.querySelector(plan?`[data-commerce="plan"][data-id="${plan.id}"]`:'[data-topup-continue]'),'commerce-checkout');
}
export async function confirmTask(account,request){
 let q=await account.command('quote',request),notice='';const profile=PROFILES[request.profile];
 const shortage=()=>Math.max(0,q.max-account.available);
 const block=()=>account.s.role==='viewer'?L('你有查看权限，请联系工作区管理员开通使用权限。','You have viewing access. Ask a workspace administrator for usage access.'):account.s.activeJobs>=account.s.entitlements.parallel_jobs?L('并行任务已达上限，可在用量记录等待完成或取消任务。','All parallel job slots are in use. Wait for completion or cancel a job in Usage.'):'';
 const labels=()=>`<p class="commerce-eyebrow">${L(profile.zh,profile.en)}</p><h3 class="commerce-task-title">${esc(request.input?.title||L(profile.zh,profile.en))}</h3><dl class="commerce-quote"><dt>${L('预计消耗','Estimated charge')}</dt><dd><b>${q.normal}–${q.high} Credit</b></dd><dt>${L('最多预留','Maximum hold')}</dt><dd>${q.max} Credit</dd><dt>${L('当前可用','Available now')}</dt><dd>${account.available.toLocaleString()} Credit</dd></dl>${notice?`<p class="commerce-feedback" role="status">${esc(notice)}</p>`:''}${block()?`<p class="commerce-callout">${block()}</p>`:shortage()?`<p class="commerce-callout">${L('还差','You need')} <b>${shortage()} Credit</b>${L(' 才能开始。充值后会返回这里，再由你确认。',' more to start. Top up, then confirm this task here.')}</p>`:''}<p>${L('先预留上限，完成后按实际模拟成本结算。余量自动释放，失败或取消不扣费。','We reserve the maximum and settle the actual fixture cost on completion. Unused credit is released; failed or cancelled jobs are free.')}</p><details><summary>${L('费用来源与报价说明','Cost sources and quote details')}</summary><p>${L('模型','Model')}: ${q.payers.model==='own'?L('自带 API · 0 Credit','Own API · 0 Credit'):L('官方服务','Platform service')}<br>${L('数据','Data')}: ${q.payers.data==='own'?L('自带 API · 0 Credit','Own API · 0 Credit'):L('官方服务','Platform service')}</p><p>${L('报价有效 120 秒。自带 API 的上游费用由你承担；本次为模拟任务，不调用付费服务。','Quote valid for 120 seconds. Own API upstream charges are yours; this simulated task makes no paid calls.')}</p></details>`;
 return modal(L('确认 Credit 用量','Confirm Credit usage'),labels(),[
  {id:'back',label:()=>shortage()&&!block()?L('充值补足','Top up Credits'):L('暂不开始','Not now'),disabled:()=>shortage()>0&&!['owner','admin'].includes(account.s.role),run:async d=>{
   if(!shortage()||block())return null;
   const result=await checkout(account,{kind:'topup',dollars:Math.min(1000,Math.max(10,Math.ceil(shortage()/1000)))});
   q=await account.command('quote',request);notice=result?.status==='delivered'?L('充值已到账。确认后才会开始本次任务。','Top-up delivered. Confirm to start this task.'):'';
   d.querySelector('.commerce-body').innerHTML=labels();return false;
  }},
  {id:'start',primary:true,label:L('确认并开始','Confirm and start'),disabled:()=>shortage()>0||!!block(),run:async d=>{
   if(Date.now()>q.expires){q=await account.command('quote',request);d.querySelector('.commerce-body').innerHTML=labels();throw Error(L('报价已刷新，请确认新的费用后再开始。','Quote refreshed. Review the updated cost and confirm again.'));}
   return account.command('job-start',{quote:q.id});
  }}
 ]);
}
export async function refund(account,id,origin=document.activeElement){
 const q=await account.command('refund-quote',{id}),order=account.s.orders.find(x=>x.id===id),undelivered=['queued','paid'].includes(order?.status);
 return modal(L('确认退款','Confirm refund'),`<p class="commerce-eyebrow">${order?.kind==='plan'?esc(PLANS[order.product].name):L('Credit 充值','Credit top-up')}</p><strong class="commerce-price">${money(q.cents)}</strong><p>${L('可退金额','Refundable amount')} · ${L('退回原支付渠道','Original payment method')}</p><dl class="commerce-quote"><dt>${undelivered?L('取消待发 Credit','Undelivered Credits cancelled'):L('收回未用 Credit','Unused Credits revoked')}</dt><dd>${(q.creditsRevoked||0).toLocaleString()}</dd><dt>${L('订阅权益','Subscription')}</dt><dd>${order?.kind==='plan'?(undelivered?L('当前套餐不变，取消本订单权益','Current plan unchanged; this order is cancelled'):L('本期订阅立即结束','Current subscription ends immediately')):L('不受影响','Unaffected')}</dd></dl><p>${L('金额根据未使用 Credit 和订阅剩余服务时间计算。已有结果仍可查看，持仓保护继续有效。','The amount reflects unused Credits and remaining subscription time. Existing results and position protection remain available.')}</p><p class="commerce-simulation">${L('当前为模拟退款，不发生真实资金转移。','Simulated refund; no real funds move.')}</p>`,[
  {id:'back',label:L('暂不退款','Keep order'),run:()=>null},
  {id:'refund',primary:true,label:L('确认退回 ','Refund ')+money(q.cents),run:()=>account.command('refund',{id,expectedCents:q.cents})}
 ],origin);
}
export function showArtifact(job,origin=document.activeElement){return modal(L('任务结果与扣费','Task result and charge'),`<p class="commerce-badge">${L('模拟结果','Simulated result')}</p><h3>${esc(job.artifact?.title||job.profile)}</h3><p>${esc(job.artifact?.summary||L('尚无已完成结果','No completed result yet'))}</p>${job.artifact?.report?`<p>${L('历史样例截至','Historical sample as of')} ${new Date(job.artifact.report.asOf).toISOString().slice(0,10)}</p>${job.artifact.report.rows.map(r=>`<div class="commerce-row"><div><b>${esc(r.asset)}</b>${r.count} ${L('根 K 线','candles')}</div><div>${r.analysis?`${L('区间变化','Period change')} ${r.analysis.change.toFixed(2)}%<br>${L('低 / 高','Low / high')} ${r.analysis.low.toFixed(2)} / ${r.analysis.high.toFixed(2)}`:L('数据不足','Insufficient data')}</div></div>`).join('')}`:''}<p class="commerce-caption">${L('任务','Task')} · ${esc(job.id)}</p>${taskCreditDetails(job)}<div class="commerce-context-links"><a data-commerce-context href="${esc(commerceContextLink({taskId:job.id},'usage'))}">${L("用量明细","Usage details")}</a><a data-commerce-context href="${esc(commerceContextLink({taskId:job.id},'billing'))}">${L('查看账单关联','View in Billing')}</a></div><p>${L('查看、复制和下载已有结果不再次扣费。','Viewing, copying and downloading an existing result is free.')}</p>`,[{id:'close',label:L('关闭','Close')}],origin);}
