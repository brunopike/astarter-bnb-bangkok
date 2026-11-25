import {L} from './execution-views.mjs';
import {escapeUI as e} from './product-experience.mjs';
import {uiGlyph} from './product-composition.mjs';

const label=value=>Array.isArray(value)?L(...value):value;
const errorText=code=>({
 MODEL_UNCONFIGURED:L('分析服务尚未配置，请稍后重试','The analysis service is not configured yet'),
 MODEL_UNAUTHORIZED:L('模型服务验证失败，请联系平台处理','The model service could not authenticate'),
 MODEL_BUDGET_REACHED:L('本小时分析额度已用完，稍后可再分析','The hourly analysis limit has been reached'),
 MODEL_RATE_LIMITED:L('分析服务繁忙，稍后可重试','The model service is busy; try again shortly'),
 MODEL_TIMEOUT:L('分析超时，输入已保留，可重新分析','Analysis timed out; your input has been retained'),
 MODEL_INVALID_RESPONSE:L('本次分析未通过结果校验，请重新分析','The analysis did not pass validation; request a new analysis'),
 MODEL_CONTEXT_LIMIT:L('本次上下文过长，请重新分析；输入已保留','The context is too long. Refresh the analysis; your input is retained'),
 PROPOSAL_OUT_OF_SCOPE:L('本次建议超出产品范围，已被风控拦截','The proposal exceeded this product’s limits and was blocked'),
 ANALYSIS_EXPIRED:L('方案数据已过期，请重新分析；问题已保留','The source data expired. Refresh the analysis; your question is retained'),
 SOURCES_EXPIRED:L('数据已过期，请重新分析','Source data expired; refresh the analysis'),
 CONFIG_CHANGED:L('产品配置已更新，请刷新后重新分析','The product changed; reload and request a new analysis'),
 QUESTION_LIMIT:L('本次分析的追问次数已用完，请重新分析','The question limit for this analysis has been reached'),
 RATE_LIMITED:L('请求较频繁，请稍后重试','Too many requests; try again shortly'),
 REQUEST_PROCESSING:L('上次请求仍在处理，请稍后查看','The previous request is still processing'),
 RECOVERY_REQUIRED:L('服务重启中断了上次请求，请重新分析','The service restarted during the request; request a new analysis'),
 SESSION_REQUIRED:L('分析会话已失效，请刷新页面','Your analysis session expired; reload the page'),
 AMOUNT:L('请核对投入金额及小数位','Check the amount and asset precision'),
 MINIMUM:L('投入金额低于本产品最低金额','The amount is below the product minimum'),
 LIMIT:L('投入金额超过本产品上限','The amount exceeds the product limit'),
 STORE_LIMIT:L('分析记录服务暂不可用','Analysis storage is currently unavailable')
})[code]||L('暂时无法完成请求，输入已保留，请重试','The request could not complete. Your input is retained; try again');
const blockedLabel=code=>({
 CONFIG_NOT_PUBLISHED:L('产品尚未开放','Product not open'),
 FUNDING_DISABLED:L('转入尚未开放','Funding not open'),
 VAULT_NOT_READY:L('金库待核验','Vault verification pending'),
 ADAPTER_UNAVAILABLE:L('执行通道待接入','Execution connection pending'),
 MARKETS_NOT_ADMITTED:L('底层标的待准入','Underlying markets not admitted'),
 COSTS_NOT_VERIFIED:L('交易与退出成本待核验','Execution and exit costs not verified'),
 POSITIONS_UNAVAILABLE:L('尚无已确认投资持仓','No confirmed investment positions')
})[code]||L('执行条件待核验','Execution checks pending');
const time=value=>value?new Date(value).toLocaleString(L('zh-CN','en-GB'),{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
const actionLabel=value=>({HOLD:L('建议保持','Hold proposal'),ALLOCATE:L('配置建议','Allocation proposal'),REBALANCE:L('调整建议','Rebalance proposal'),COMPOUND:L('复投建议','Compound proposal'),PROTECT:L('风险收缩建议','Protection proposal')})[value]||L('策略分析','Strategy analysis');
const sourcesHTML=sources=>'<div class="wealth-manager-sources">'+sources.map((s,i)=>{
 const safe=typeof s.url==='string'&&(/^\?/.test(s.url)||/^\/\?/.test(s.url)||/^https:\/\/(?:etherscan\.io|aave\.com)\//.test(s.url)),name=s.kind==='market'?(s.status==='observed'?L('链上观察','On-chain observation'):L('数据状态','Data status')):L('产品配置','Product configuration');
 if(s.kind!=='market')return '<button type="button" data-wealth-op="terms">['+(i+1)+'] '+name+(s.asOf?' · '+time(s.asOf):'')+'</button>';
 return safe?'<a href="'+e(s.url)+'" '+(s.url.startsWith('https:')?'target="_blank" rel="noopener noreferrer"':'')+'>['+(i+1)+'] '+name+(s.asOf?' · '+time(s.asOf):'')+'</a>':'';
}).join('')+'</div>';
function readableAnalysis(value){
 const out=value?.output,rows=value?.context?.allocations;
 return value?.kind==='analysis'&&value.method==='ai'&&typeof value.id==='string'&&Number.isFinite(value.createdAt)&&Number.isFinite(value.expiresAt)&&['headline','summary','nextStep','action'].every(k=>typeof out?.[k]==='string')&&['reasons','tradeoffs'].every(k=>Array.isArray(out[k])&&out[k].length<=4&&out[k].every(v=>typeof v==='string'))&&Array.isArray(out.allocations)&&out.allocations.length<=7&&out.allocations.every(r=>typeof r.productId==='string'&&Number.isInteger(r.weightBps)&&r.weightBps>=0&&r.weightBps<=10000)&&Array.isArray(rows)&&rows.every(r=>typeof r.productId==='string'&&(typeof r.name==='string'||Array.isArray(r.name)&&r.name.every(v=>typeof v==='string')))&&Array.isArray(value.sources)&&value.sources.length<=8&&value.sources.every(s=>s&&typeof s.id==='string')&&Array.isArray(value.execution?.reasons)&&value.execution.reasons.every(r=>typeof r==='string');
}
export function managerContextKey(context){
 return context?JSON.stringify([context.profileId,context.assetId,context.amount.trim(),context.configVersion,context.locale,context.configStamp||'']):'';
}
export function createWealthManagerClient({root,getContext,onReview,fetchImpl=fetch}){
 let contextKey='',poolKey='',revision=0,statusRevision=0,capabilities=null,analysis=null,turns=[],draft='',busy='',error='',notice='',requestId=null,pendingQuestion=null,controller=null,poll=null;
 const actions='<button type="button" class="p-button" data-manager-action="status">'+L('重试连接','Retry connection')+'</button>';
 function current(){return getContext();}
 function paint(){const host=root.querySelector('[data-wealth-manager]');if(!busy&&host?.contains?.(document.activeElement)&&document.activeElement?.matches?.('[data-manager-question]'))return;if(host){const opened=Array.from(host.querySelectorAll?.('details')||[],d=>d.open);host.innerHTML=render();Array.from(host.querySelectorAll?.('details')||[]).forEach((d,i)=>{if(opened[i])d.open=true;});}}
 async function api(path,{method='GET',body,signal}={}){
  const response=await fetchImpl('/api/wealth/manager'+path,{method,credentials:'same-origin',cache:'no-store',headers:method==='POST'?{'Content-Type':'application/json','X-Astarter-Wealth':'1'}:{},...(body?{body:JSON.stringify(body)}:{}),signal:signal||AbortSignal.timeout(45000)});
  let result;try{result=await response.json();}catch{throw Error('MANAGER_UNAVAILABLE');}
  if(!response.ok)throw Error(result.error||'MANAGER_UNAVAILABLE');return result;
 }
 function sync(){
  const context=current(),key=managerContextKey(context);
  if(key!==contextKey){contextKey=key;revision++;controller?.abort();controller=null;analysis=null;turns=[];busy='';error='';notice='';requestId=null;pendingQuestion=null;}
  return context;
 }
 async function loadStatus(){
  const context=current();if(!context)return;const key=[context.profileId,context.assetId,context.configVersion].join(':'),token=++statusRevision;
  try{const result=await api('/status?profileId='+encodeURIComponent(context.profileId)+'&assetId='+encodeURIComponent(context.assetId));if(token!==statusRevision)return;
   if([current()?.profileId,current()?.assetId,current()?.configVersion].join(':')!==key)return;
   capabilities=result;poolKey=key;if(result.monitor?.active)startPolling();else stopPolling();paint();
  }catch{if(token===statusRevision){capabilities={...capabilities,unavailable:true};paint();}}
 }
 function stopPolling(){if(poll){clearInterval(poll);poll=null;}}
 function startPolling(){if(!poll)poll=setInterval(()=>{if(!root.querySelector('[data-wealth-manager]')){stopPolling();return;}void loadStatus();},10000);}
 function bind(){
  const context=sync();if(!context)return;
  const key=[context.profileId,context.assetId,context.configVersion].join(':');if(key!==poolKey){poolKey=key;capabilities=null;void loadStatus();}else if(capabilities?.monitor?.active&&!poll)void loadStatus();
 }
 function changed(){sync();paint();}
 async function analyze(){
  const context=sync();if(!context||busy)return;
  if(context.vaultMode&&onReview){await onReview();return;}
  const token=revision,key=contextKey;busy='analysis';error='';notice='';requestId||=crypto.randomUUID();controller=new AbortController();const activeController=controller;const timeout=setTimeout(()=>activeController.abort(),45000);paint();
  try{
   if(!capabilities||capabilities.unavailable)await loadStatus();
   const configHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(context.configStamp||'')))).map(v=>v.toString(16).padStart(2,'0')).join('');if(token!==revision)return;
   const result=await api('/analyses',{method:'POST',body:{profileId:context.profileId,assetId:context.assetId,amount:context.amount,configVersion:context.configVersion,configHash,locale:context.locale,requestId},signal:activeController.signal});
   if(token!==revision||key!==managerContextKey(current()))return;
   if(!readableAnalysis(result))throw Error('MODEL_INVALID_RESPONSE');
   analysis=result;turns=[];requestId=null;notice=L('已按本产品范围完成分析','Analysis completed within this product’s mandate');
  }catch(issue){if(token===revision){error=errorText(issue.name==='AbortError'?'MODEL_TIMEOUT':issue.message);if(!['TypeError','AbortError'].includes(issue.name))requestId=null;}}
  finally{clearTimeout(timeout);if(token===revision){busy='';controller=null;paint();root.querySelector('[data-manager-heading]')?.focus({preventScroll:true});}}
 }
 async function ask(question=draft){
  if(busy||!analysis||!question.trim())return;
  const token=revision,id=analysis.id;pendingQuestion&&pendingQuestion.question===question?null:pendingQuestion={question,requestId:crypto.randomUUID()};
  busy='question';error='';notice='';controller=new AbortController();const activeController=controller;const timeout=setTimeout(()=>activeController.abort(),45000);paint();
  try{
   const result=await api('/analyses/'+encodeURIComponent(id)+'/questions',{method:'POST',body:pendingQuestion,signal:activeController.signal});
   if(token!==revision||analysis?.id!==id)return;
   if(result.analysisId!==id||result.method!=='ai'||typeof result.output?.answer!=='string')throw Error('MODEL_INVALID_RESPONSE');
   turns.push(result);draft='';pendingQuestion=null;
  }catch(issue){if(token===revision){draft=question;error=errorText(issue.name==='AbortError'?'MODEL_TIMEOUT':issue.message);if(!['TypeError','AbortError'].includes(issue.name))pendingQuestion=null;}}
  finally{clearTimeout(timeout);if(token===revision){busy='';controller=null;paint();root.querySelector('[data-manager-question]')?.focus({preventScroll:true});}}
 }
 async function monitor(){
  if(busy)return;const token=revision,wasActive=!!capabilities?.monitor?.active;
  if(!wasActive&&!analysis)return;busy='monitor';error='';paint();
  try{const result=await api('/monitor',{method:'POST',body:wasActive?{enabled:false,poolId:capabilities.monitor.poolId}:{enabled:true,analysisId:analysis.id}});
   if(token!==revision)return;capabilities={...capabilities,monitor:result};if(result.active)startPolling();else stopPolling();
  }catch(issue){if(token===revision)error=errorText(issue.message);}
  finally{if(token===revision){busy='';paint();root.querySelector('[data-manager-action="monitor"]')?.focus({preventScroll:true});}}
 }
 function render(){
  const context=sync();if(!context)return '';
  const live=analysis&&analysis.expiresAt>Date.now(),monitor=capabilities?.monitor,decision=monitor?.decision,body=analysis?.output;
  if(context.vaultMode){
   const headline=!context.hasPosition&&context.hasPending?L('赎回已受理，等待 T+2 到账','Redemption accepted; awaiting calendar T+2 payment'):!context.hasPosition&&context.hasSettled?L('本期已结算，资金记录可查','Cycle settled; payment records are available'):context.processing?L('正在比较收益、风险与退出能力','Comparing yield, risk and exit liquidity'):context.riskPaused?L('暂停新增配置，优先保护退出流动性','New allocation paused to protect exit liquidity'):body&&analysis.execution.status==='sandbox_executed'?context.investedCount?L('当前配置 '+context.investedCount+' 个收益方向，流动储备 '+context.actualReservePercent+'%','Allocated across '+context.investedCount+' yield sleeves with '+context.actualReservePercent+'% liquidity'):L('AI 保留资金，等待配置机会','AI retains capital while awaiting an opportunity'):body?.headline||L('投入后，AI 自动配置并持续检查','AI allocates and monitors after funding');
   const status=context.riskPaused?L('保护中','Protected'):context.processing?L('正在处理','Processing'):context.hasPosition?context.executionVerified?L('管理中','Managing'):L('待复核','Review pending'):L('等待投入','Ready to fund');
   let compact='<div class="wealth-manager-heading"><h3 tabindex="-1" data-manager-heading>'+L('AI 资管经理','AI portfolio manager')+'</h3><span>'+status+'</span></div><p class="wealth-ai-judgment">'+e(headline)+'</p>';
   compact+='<div class="wealth-ai-actions">'+(context.hasPosition?'<button type="button" class="p-button" data-manager-action="analyze" '+(context.processing?'disabled':'')+'>'+L('重新评估','Review again')+'</button>':'')+(body?'<span>'+L('最近决策','Last decision')+' · '+time(analysis.createdAt)+'</span>':'')+'</div>';
   if(body){compact+='<details class="wealth-ai-explanation"><summary>'+L('判断依据与追问','Reasoning & questions')+'</summary><p><b>'+e(body.headline)+'</b></p><p>'+e(body.summary)+'</p><ul>'+body.reasons.map(r=>'<li>'+e(r)+'</li>').join('')+'</ul>'+sourcesHTML(analysis.sources)+'<p class="wealth-ai-proof">'+(analysis.execution.status==='sandbox_executed'?L('已在测试金库执行','Executed in the test vault'):L('策略建议，等待执行确认','Proposal awaiting execution confirmation'))+'</p>';
    compact+=turns.map(turn=>'<article class="wealth-ai-turn"><b>'+e(turn.question)+'</b><p>'+e(turn.output.answer)+'</p>'+(turn.termsSnapshot?'<p class="wealth-ai-proof">'+L('本产品条款：','Product terms: ')+e(String(turn.termsSnapshot.lockDays))+L('天封闭期 · ',' days locked · ')+e(String(turn.termsSnapshot.maturityDays))+L('天到期 · 提前赎回费 ',' days to maturity · Early exit fee ')+e(String(turn.termsSnapshot.earlyRedemptionPercent))+'% · '+L('赎回受理后48小时（T+2自然日）。流动储备不豁免封闭期，无本金兑付保证。','48 hours after redemption acceptance (calendar T+2). The reserve does not waive the lock. No principal guarantee.')+'</p>':'')+'</article>').join('');
    compact+='<form data-manager-form><label class="sr-only" for="wealth-manager-question">'+L('追问本产品','Ask about this product')+'</label><textarea id="wealth-manager-question" data-manager-question rows="2" maxlength="1200" placeholder="'+L('问 AI：为什么这样配置？','Ask AI: why this allocation?')+'" '+(busy||!live?'disabled':'')+'>'+e(draft)+'</textarea><button type="submit" class="p-button" '+(busy||!live?'disabled':'')+'>'+(busy==='question'?L('回答中…','Answering…'):L('发送','Send'))+'</button></form>'+(live?'':'<p>'+L('分析快照已过期，可重新评估后追问','The decision snapshot expired; review again to ask questions')+'</p>')+'</details>';
   }
   return compact+'<p class="wealth-manager-feedback '+(error?'wealth-error':'')+'" role="'+(error?'alert':'status')+'">'+e(error)+'</p>';
  }
  let html='<div class="wealth-manager-heading"><h3 tabindex="-1" data-manager-heading>'+L('AI 策略经理','AI strategy manager')+'</h3><span>'+L('专注当前产品','For this product')+'</span></div>';
  if(body){
   html+='<div class="wealth-manager-verdict"><span class="wealth-manager-action">'+actionLabel(body.action)+'</span><h4>'+e(body.headline)+'</h4><p>'+e(body.summary)+'</p></div>';
   html+='<ul class="wealth-manager-reasons">'+body.reasons.map(reason=>'<li>'+e(reason)+'</li>').join('')+'</ul>';
   if(body.tradeoffs.length)html+='<details class="wealth-manager-detail"><summary>'+L('取舍与配置建议','Tradeoffs & allocation proposal')+'</summary><ul>'+body.tradeoffs.map(reason=>'<li>'+e(reason)+'</li>').join('')+'</ul><dl>'+body.allocations.map(row=>'<div><dt>'+e(label(analysis.context.allocations.find(a=>a.productId===row.productId)?.name||row.productId))+'</dt><dd>'+row.weightBps/100+'%</dd></div>').join('')+'</dl></details>';
   html+='<div class="wealth-manager-next"><b>'+L('下一步','Next step')+'</b><p>'+e(body.nextStep)+'</p></div>'+sourcesHTML(analysis.sources);
   html+='<details class="wealth-manager-audit"><summary>'+L('分析记录','Analysis record')+' · '+time(analysis.createdAt)+'</summary><p>'+e(analysis.model)+' · '+e(analysis.responseId)+'</p><p>'+L('建议尚未执行','Proposal not executed')+' · '+analysis.execution.reasons.map(blockedLabel).join(' · ')+'</p></details>';
   if(!live)html+='<p class="wealth-manager-stale">'+L('分析数据已过期，重新分析后可继续追问','Source data expired; refresh the analysis to continue asking questions')+'</p>';
  }else{
   html+='<div class="wealth-manager-intro"><p>'+L('由 AI 解读这套链上策略的收益来源、调配条件和退出安排。投入资金后，管理范围始终遵循本产品的授权规则。','Let AI explain this on-chain strategy’s yield sources, allocation triggers and exit terms. Management remains within this product’s approved mandate.')+'</p><div class="wealth-manager-boundaries"><span>'+L('单项上限','Product cap')+' '+context.capPercent+'%</span><span>'+L('流动储备','Liquid reserve')+' ≥'+context.reservePercent+'%</span><span>'+L('四产品独立管理','Four separately managed products')+'</span></div></div>';
  }
  html+='<div class="wealth-manager-toolbar"><button type="button" class="p-button" data-manager-action="analyze" '+(busy?'disabled':'')+'>'+uiGlyph('orbit')+'<span>'+(busy==='analysis'?L('正在读取数据并分析…','Reading data and analysing…'):body?L('重新分析','Refresh analysis'):L('查看 AI 策略分析','View AI strategy analysis'))+'</span></button><span>'+e(notice||(capabilities?.unavailable?L('分析服务连接失败','Analysis service unavailable'):capabilities?.model?.configured?L('AI分析已连接','AI analysis connected'):capabilities?.model?L('模型服务待配置','Model setup pending'):L('正在连接分析服务','Connecting analysis service')))+'</span>'+(capabilities?.unavailable?actions:'')+'</div>';
  if(body){
   html+='<section class="wealth-manager-conversation" aria-label="'+L('追问策略经理','Ask the strategy manager')+'">'+turns.map(turn=>'<article><p class="wealth-manager-user">'+e(turn.question)+'</p><p class="wealth-manager-answer">'+e(turn.output.answer)+'</p>'+(turn.termsSnapshot?'<div class="wealth-manager-authoritative-terms"><b>'+(turn.termsSnapshot.parametersAreDraft?L('条款草案','Draft terms'):L('本产品条款','Product terms'))+'</b><span>'+L('管理年费 / 认购费','Annual management / subscription')+' '+e(String(turn.termsSnapshot.managementAnnualPercent))+'% / '+e(String(turn.termsSnapshot.subscriptionPercent))+'%</span><span>'+L('高水位提成','High-water-mark performance fee')+' '+e(String(turn.termsSnapshot.performancePercent))+'% · '+L('按批次，仅对扣管理费后的新高收益计提','Per lot, on new gains after management fees')+'</span><span>'+L('封闭期自份额确认起','Lock starts at share confirmation')+' · '+e(String(turn.termsSnapshot.lockDays))+' '+L('天','days')+' · '+e(String(turn.termsSnapshot.maturityDays))+' '+L('天到期自动赎回','days to automatic redemption at maturity')+'</span><span>'+L('赎回受理后48小时','48 hours after redemption acceptance')+' · T+2 '+L('自然日','calendar days')+'</span><span>'+L('提前赎回费','Early exit fee')+' '+e(String(turn.termsSnapshot.earlyRedemptionPercent))+'% · '+L('无本金兑付保证','No principal guarantee')+'</span></div>':'')+'</article>').join('')+'<div class="wealth-manager-prompts">'+[L('这套策略如何调仓？','How does this strategy rebalance?'),L('费用与退出怎么计算？','How do fees and exits work?')].map(q=>'<button type="button" data-manager-prompt="'+e(q)+'" '+(busy||!live?'disabled':'')+'>'+e(q)+'</button>').join('')+'</div><form data-manager-form><label class="sr-only" for="wealth-manager-question">'+L('追问本产品','Ask about this product')+'</label><textarea id="wealth-manager-question" data-manager-question rows="2" maxlength="1200" placeholder="'+L('围绕本产品继续追问…','Ask a follow-up about this product…')+'" '+(busy||!live?'disabled':'')+'>'+e(draft)+'</textarea><button type="submit" class="p-button" '+(busy||!live?'disabled':'')+'>'+(busy==='question'?L('回答中…','Answering…'):L('追问','Ask'))+'</button></form></section>';
  }
  html+='<section class="wealth-manager-monitor"><header><div><h4>'+L('持续管理','Continuous management')+'</h4><p>'+(monitor?.active?L('跟踪中，收益或风险变化会触发复核','Monitoring; yield or risk changes trigger review'):L('跟踪本产品的收益和风险变化，按原授权范围复核','Track this product’s yield and risk changes within its mandate'))+'</p></div><button type="button" class="p-button" data-manager-action="monitor" '+(busy||!monitor?.active&&!live?'disabled':'')+'>'+(monitor?.active?L('暂停跟踪','Pause monitoring'):L('开启策略跟踪','Start monitoring'))+'</button></header>';
  if(monitor?.lastCheckAt)html+='<p class="wealth-manager-check">'+L('上次检查','Last checked')+' '+time(monitor.lastCheckAt)+(monitor.active?' · '+L('下次','Next')+' '+time(monitor.nextCheckAt):'')+'</p>';
  if(decision)html+='<div class="wealth-manager-pool-decision"><b>'+e(decision.output.headline)+'</b><p>'+e(decision.output.summary)+'</p><small>'+time(decision.createdAt)+' · '+L('产品资金池复核，尚未执行','Product-pool review; not executed')+'</small></div>';
  if(monitor?.events?.length)html+='<ul class="wealth-manager-events">'+monitor.events.slice(0,4).map(event=>'<li><time>'+time(event.at)+'</time><span>'+(event.data.reason==='RESERVE_RISK'?L('储备风险信号持续，维持保护状态','Reserve risk persists; protection maintained'):({reviewed:L('已完成AI策略复核','AI review completed'),checked:L('已核对链上数据，未发现显著变化','On-chain data checked; no material change'),awaiting_data:L('数据暂不可用，等待恢复','Data unavailable; waiting for recovery'),blocked:L('复核条件未满足','Review prerequisites not met')})[event.kind])+(event.data.aprPercent?' · '+L('参考借贷APR','Reference lending APR')+' '+e(event.data.aprPercent)+'%':'')+'</span></li>').join('')+'</ul>';
  html+='</section><p class="wealth-manager-feedback '+(error?'wealth-error':'')+'" role="'+(error?'alert':'status')+'">'+e(error)+'</p>';return html;
 }
 root.addEventListener('click',event=>{
  const prompt=event.target.closest('[data-manager-prompt]');if(prompt&&root.contains(prompt)){draft=prompt.dataset.managerPrompt;void ask(draft);return;}
  const target=event.target.closest('[data-manager-action]');if(!target||!root.contains(target))return;
  if(target.dataset.managerAction==='analyze')void analyze();else if(target.dataset.managerAction==='monitor')void monitor();else if(target.dataset.managerAction==='status')void loadStatus();
 });
 root.addEventListener('input',event=>{if(event.target.matches?.('[data-manager-question]'))draft=event.target.value;});
 root.addEventListener('submit',event=>{if(event.target.matches?.('[data-manager-form]')){event.preventDefault();void ask();}});
 root.addEventListener('keydown',event=>{if(event.target.matches?.('[data-manager-question]')&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();void ask();}});
 return {render,bind,changed,analyze,ask,loadStatus,adopt(record){sync();if(!record||!readableAnalysis(record))return;if(analysis?.id!==record.id){analysis=record;turns=[];error='';}else analysis=record;paint();},destroy(){controller?.abort();stopPolling();}};
}
