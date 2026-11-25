import {BOT_MARKETS,isBotSimulation,botParameters as recommendedBotParameters,editorPlanError,liveBinanceSpotRoute,liveWalletSpotRoute,botRequiredCapital,MIN_ORDER_USDT} from './bot-runtime.mjs';
import {botPlanFingerprint,saveBotEditor,clearBotEditor,readBotEditor,loadBotEditors,botGridPreviewKey,botGridPreview,botRecommendationIssue,botBudgetAmount} from './strategy-routing.mjs';
import {defaultStrategyRoute,attachConnectedBinanceSpot,unpinnedCexSpotSetup,routeAssets,strategyMarkets,strategyVenues,strategyRouteValid,strategyRouteReady,strategyRouteConnected,strategyRouteFields,strategyConnection,bindStrategyConnection,signedWalletRoute,signedExchangeRoute,strategyAccessOptions,routeSummary,STRATEGY_MARKETS} from './strategy-routing.mjs?v=20261123m';
import {botManagementSummary,botRunStats,botHistoryView,botTemplateOverview,botCreationFrame,botParameterFields,botParameterRows,botParameterFacts,botProtectionRows,botInstanceStatus,botInstancesView} from './strategy-bot-views.mjs';
import {mountCharts} from './product-chart-ui.mjs';
import {refreshNumberInputs} from './product-number-input.mjs';
import {sameWatchAssetKey} from './market-watchlist.mjs';
import {formatDataTime} from './product-help.mjs';
import {tradingChartPanel,readTradingChartQuote,formatTradingPrice} from './trading-chart.mjs';
import {accessPanel} from './trading-access-view.mjs';
import {accessMessage} from './trading-access.mjs?v=20261120c';
import {TRADERS} from './data-center-fixtures.mjs';
import {SOCIAL_POSTS} from './social-trading.mjs';
import {uiGlyph,canAutoRefresh} from './product-composition.mjs';
import {strategyArt,strategyTimeframe,STRATEGY_STORY,createStrategyArtMotion} from './strategy-art.mjs';
import {protectionConfig,protectionValid,protectionKey,companionPreview,PROTECTION_VERSION} from './strategy-protection.mjs';
import {L,scopeHeader} from './execution-views.mjs';
import {CATALOG,strategyById,BOT_PRODUCT_CAPABILITIES} from './strategy-catalog.mjs';
import {strategyPlan,strategyScope,strategyVariants,strategyFlowAvailable,PARAMETER_LABELS,defaultBotVariant} from './strategy-execution-data.mjs';
import {tokenIcon,venueIcon} from './brand-icons.mjs';
import {WALLET_NETWORKS,spendableSpotUsdt,spendableWalletUsdt,tradingConnections} from './connection-options.mjs?v=20261122a';
import {contextError} from './platform-context.mjs';
import {escapeUI as e} from './product-experience.mjs';
import {QUESTIONS,recommend,runnableRecommendation,profileLossLimit,publicAddressValid,COPY_DEFAULTS,copyConfigError,replayCopy,applyRecommendation,strategySetupCosts,strategyRecommendations,RESEARCH_STRATEGIES} from './strategy-advisor.mjs';
const B=(zh,en,act,id='',primary=false,disabled=false)=>`<button type="button" class="p-button ${primary?'p-primary':''}" data-journey="${act}" data-id="${e(id)}" ${disabled?'disabled':''}>${L(zh,en)}</button>`;
const go=(z,en,page)=>`<button class="p-button" data-biz="go" data-id="${page}">${L(z,en)}</button>`;
const head=(z,en,sub,suben,actions='')=>`<header class="p-head"><div><h1>${L(z,en)}</h1><p>${L(sub,suben)}</p></div><div class="p-actions">${actions}</div></header>`;
const kv=rows=>`<dl class="ux-facts">${rows.map(([k,v])=>`<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const modes={signal:['只提醒我','Notify me'],confirm:['旧设置 · 需要更新','Legacy setup · update required'],review:['旧设置 · 逐笔批准','Legacy · approve entries'],auto:['按批准规则运行','Run approved rules']};
const reasons={'not-trade':['只是转账，不跟随','Transfer only; no trade'],duplicate:['重复或历史快照，跳过','Duplicate or snapshot; skipped'],stale:['来晚了，跳过','Signal too old'],price:['价格偏离太多','Price or slippage limit'],liquidity:['流动性不足','Insufficient liquidity'],'not-owned':['不是这套策略买的，不卖','No strategy-owned position'],'exit-off':['没有开启跟随卖出','Following exits is off'],'owned-exit':['按比例卖出自己跟随的部分','Exit strategy-owned amount'],accepted:['检查通过，模拟买入','Checks passed; paper entry'],cap:['超过资金限制','Allocation limit'],leverage:['超过杠杆限制','Leverage limit'],stop:['触及止损，模拟退出并暂停买入','Stop reached; paper exit and pause'],halted:['保护已触发，暂停买入','Protection active; entry paused'],'within-risk':['未触及止损','Within stop limit']};
export function traderDiscoveryView(){
 const styles={'趋势跟踪':'Trend following','链上研究':'On-chain research','宏观观察':'Macro research','波段交易':'Swing trading','合约交易':'Perpetuals','短线交易':'Short-term trading','资金流':'Fund flows','事件跟踪':'Event-driven','资金研究':'Fund-flow research','区间交易':'Range trading','波动研究':'Volatility research','现货交易':'Spot trading'};
 return `<div class="ux-page copy-directory" data-localized-ui>${head('聪明钱跟随','Smart-money watchlist','','',`<a class="p-button" href="?page=social&amp;data=demo">${L('查看账户动态','Account activity')}</a>`)}<div class="copy-directory-notice"><span>${L('示例数据','Sample data')}</span><span class="sc-tag">${L('自动跟单尚未开放','Copy trading unavailable')}</span></div><section class="copy-trader-list" aria-label="${L('交易者账户','Trader accounts')}">${TRADERS.map(trader=>{
 const latest=SOCIAL_POSTS.filter(p=>p.trader===trader.id).sort((a,b)=>b.time.padStart(5,'0').localeCompare(a.time.padStart(5,'0')))[0];
 const accountHref='?'+e(new URLSearchParams({page:'social',data:'demo',trader:trader.id}).toString());
 const name=L(trader.name,trader.name.split(' / ')[0]),assets=[...new Set(SOCIAL_POSTS.filter(p=>p.trader===trader.id).map(p=>p.asset))];
 return `<article class="copy-trader-row"><a href="${accountHref}" class="copy-trader-person"><span class="copy-trader-avatar" style="--trader-color:${trader.color}">${e(trader.initial)}</span><span><b>${e(name)}</b><small>${e(L(trader.platform,trader.platform==='链上'?'On-chain':trader.platform))} · ${e(L(trader.style,styles[trader.style]||trader.style))}</small></span></a><div class="copy-trader-assets"><small>${L('常看资产','Focus assets')}</small><span>${assets.map(a=>`<a href="?page=markets&asset=${a}">${a}</a>`).join('')}</span></div><a class="copy-trader-update" href="${accountHref}&amp;view=history"><small>${latest?.time||'—'} · ${L('最近观点','Latest view')}</small><span>${e(latest?L(latest.text,latest.textEn||latest.text):L('查看账户的历史动态','Open account history'))}</span></a><a class="p-button copy-trader-open" href="${accountHref}" aria-label="${e(L('查看 '+name+' 的账户','View '+name+' account'))}">${L('查看账户','Profile')}${uiGlyph('arrow')}</a></article>`;
 }).join('')}</section></div>`;
}
export function createStrategyJourneys({w,go:route,refresh,notify,onApply}){
 let step=0,answers={...(w.s.advisor?.answers||{})},done=false;
 let profileAddress=w.s.advisor?.address||'',profileChain=w.s.advisor?.chain||'evm';
 let copy={...COPY_DEFAULTS,...w.s.copyStrategy?.params},copyAddress=w.s.copyStrategy?.address||'',copyChain=w.s.copyStrategy?.chain||'solana';
 let addressFeedback='',copyFeedback='',resultFeedback='',resultIssue='';
 const persistAnswers=()=>{w.s.advisor={...w.s.advisor,answers:{...answers},address:profileAddress,chain:profileChain};w.touch();};
 function advisor(){const q=QUESTIONS[step],r=runnableRecommendation(answers,w.quote(8));
  if(done&&r)return result(r);
  return `<div class="ux-page ux-advisor" data-localized-ui><div class="ux-question-progress"><span>${L('找到适合你的设置','Find your settings')}</span><b>${step+1} / 5</b><div>${QUESTIONS.map((_,i)=>`<i class="${i<=step?'on':''}"></i>`).join('')}</div></div><main class="ux-question"><h1>${L(...q.title)}</h1><p>${L(...q.hint)}</p><div class="ux-answer-list">${q.choices.map(([v,z,en,multiplier],i)=>`<button class="ux-answer ${answers[q.key]===v?'selected':''}" data-journey="answer" data-id="${v}" aria-pressed="${answers[q.key]===v}"><span>${i+1}</span><b>${q.key==='risk'?profileLossLimit(answers.capital,v)+' USDT':L(z,en)}${q.key==='risk'?`<small>${L(z,en)}</small>`:q.key==='pace'?`<small>${L('每日上限','Daily limit')} ${w.quote(8)*multiplier} ${L('AI 积分','AI credits')}</small>`:''}</b><i aria-hidden="true">${answers[q.key]===v?'✓':'→'}</i></button>`).join('')}</div><footer>${B('上一步','Back','back','',false,step===0)}</footer><div class="ux-question-exit">${go('返回策略广场','Back to strategies','strategies')}</div></main></div>`;
 }
 function result(r){
  const strategy=strategyById(r.strategy),reason=r.strategy==='RX01'?['先观察事件，再等价格确认。只提醒，不自动下单。','Watch events, then wait for price confirmation. Notify only; no automatic orders.']:r.strategy==='S04'?['等突破与回踩确认，再按你的限制处理。','Wait for a break and retest, then act within your limits.']:r.strategy==='S07'?['让价格与成交量一起确认，起步资金更克制。','Wait for price and volume together, with smaller starting entries.']:['顺着趋势找机会，再由动量确认。','Follow the trend and wait for momentum to confirm.'];
  const variant=defaultBotVariant(r.strategy),ready=isBotSimulation({strategy:r.strategy,planVariant:variant})&&strategyPlan(r.strategy,variant).flowAvailable;
  return `<div class="ux-page ux-profile-result" data-localized-ui>${head('你的起步方案','Your starting plan','','','')}<div class="ux-profile-layout"><section class="ux-profile-method"><div class="ux-advice-art" data-kind="${scText(strategy)[4]}">${strategyArt(r.strategy)}</div><div class="ux-profile-method-body"><h2>${strategyName(strategy)}</h2><p>${L(...reason)}</p><p class="ux-inline-note">${L(ready?'先选账户和资产，再把投入与保护设好。检查通过后，由你批准模拟。':'从这份研究方案起步。保存你的偏好，再核对策略与风险边界；该版本尚未开放机器人模拟。',ready?'Choose an account and asset, set allocation and protection, then review and approve the simulation.':'Start with a research plan. Save your preferences and review the strategy and risk limits. BOT simulation is not available for this version.')}</p>${r.conflict?`<p class="ux-inline-note">${L('你选择了先观察，所以只提醒，不会自动交易。','You chose to observe first, so this starts with notifications only.')}</p>`:''}<details class="ux-profile-address"><summary>${L('补充你的公开地址','Add your public address')}<span>${L('可选','Optional')}</span></summary><p>${L('可选。先保存地址，历史交易分析等数据接入后再做。','Optional. Save an address for analysis when history data is connected.')}</p><form id="advisor-address"><label class="p-field">${L('地址网络','Network')}<select name="chain"><option value="evm" ${profileChain==='evm'?'selected':''}>EVM</option><option value="solana" ${profileChain==='solana'?'selected':''}>Solana</option></select></label><label class="p-field">${L('公开钱包地址','Public wallet address')}<input name="address" value="${e(profileAddress)}" autocomplete="off" placeholder="0x… / Solana"></label><button class="p-button" type="submit">${L('保存地址','Save address')}</button><p role="status" class="ux-form-feedback">${addressFeedback==='invalid'?L('地址格式不对，请检查网络和完整地址。','Check the network and full address.'):addressFeedback?e(addressFeedback):''}</p></form><small>${L('只检查格式，不代表地址归你所有。不要填写私钥或助记词。','Format check only; ownership is not verified. Never enter a private key or seed phrase.')}</small></details></div></section><aside class="ux-profile-settings"><header class="ux-profile-setting-head"><h2>${L('起步设置','Starting settings')}</h2>${B('重新调整','Adjust answers','revise')}</header>${kv([[L('这套策略最多使用','Strategy allocation'),`${r.cap.toLocaleString('en-US')} USDT`],[L('每次最多买入','Maximum per order'),`${r.amount} USDT`],[L('你的执行偏好','Your execution preference'),r.mode==='auto'?L('按规则自动执行','Follow approved rules'):L(...modes[r.mode])],[L('资金保护','Capital protection'),L(answers.risk==='low'?'Astarter · 保守':'Astarter · 正常',answers.risk==='low'?'Astarter · Conservative':'Astarter · Normal')],[L('期望亏损暂停线','Requested loss pause limit'),r.dailyLoss+' USDT'],[L('期望每日研究上限','Requested daily research limit'),r.daily+' '+L('AI 积分','AI credits')]])}<details class="ux-profile-account"><summary>${L('账户限制','Account limits')}</summary>${kv([[L('账户总上限','Account limit'),`${w.s.risk.cap} USDT`],[L('账户亏损暂停线','Account loss pause limit'),`${w.s.risk.dailyLoss} USDT`]])}<p>${L('五问帮你整理偏好，账户限制继续生效。保存后，再核对所选版本的执行能力、金额与保护。','These answers organize your preferences. Account limits still apply. After saving, review the chosen version’s capabilities, sizing and protection.')}</p></details>${creditSummary(w)}<div class="ux-profile-cta"><p class="ux-form-feedback" role="alert">${e(resultFeedback)}</p>${B(ready?'应用并继续':'配置研究方案',ready?'Apply & continue':'Set up research','apply','',true)}${resultIssue==='busy'?go('查看我的策略','View my strategies','my-strategies'):resultIssue==='resource'?go('查看已保存方案','View saved plans','my-strategies'):go('策略库','All strategies','strategies')}</div></aside></div></div>`;
 }
 function field(z,en,key,min,max,step='1'){return `<label class="p-field">${L(z,en)}<input name="${key}" type="number" min="${min}" max="${max}" step="${step}" required value="${e(copy[key])}"></label>`;}
 function copyPage(){return traderDiscoveryView();}
 function copyResults(run){return `<section class="ux-run-panel" data-localized-ui><div class="ux-section-title"><h2>${L('跟随演练结果','Copy replay result')}</h2><span>${e(run.id)} · v${run.version} · ${run.points} ${L('AI 积分','AI credits')}</span></div><div class="p-table-scroll"><table class="p-table"><thead><tr>${[L('事件','Event'),L('资产','Asset'),L('处理结果','Decision'),L('模拟金额','Paper amount')].map(s=>`<th>${s}</th>`).join('')}</tr></thead><tbody>${run.result.records.map(r=>`<tr><td>${e(r.id)}<small>${L(...({transfer:['转账','Transfer'],fill:['成交','Fill'],risk:['风险变化','Risk change']}[r.kind]||[r.kind,r.kind]))}</small></td><td>${e(r.symbol)}</td><td><span class="ux-pill ${r.status==='paper-entry'?'good':''}">${L(...reasons[r.reason])}</span></td><td>${r.amount?r.amount.toFixed(2)+' USDT':'—'}</td></tr>`).join('')}</tbody></table></div><p class="p-footnote">${L('这是固定样例的规则回放，不是地址历史回测。金额按样例名义值记账，未计算盈亏、手续费和资金费。','Fixed-event rule replay, not a wallet backtest. Amounts are fixture notionals; P&L, fees and funding are not calculated.')}</p></section>`;}
 function contributions(){const records=w.s.contributions||[],eligible=w.s.drafts.filter(d=>d.status==='passed'&&d.validatedVersion===d.version&&d.riskVersion===w.s.risk.version);return `<div class="ux-page" data-localized-ui>${head('我的贡献','My contributions','把你的交易方法变成可检查、可复用的策略。','Turn your trading approach into a strategy others can evaluate.',go('调整我的策略','Edit my strategies','my-strategies'))}<div class="ux-copy-banner"><div><span class="ux-pill">${L('策略贡献','Strategy contributions')}</span><h2>${L('有一套自己的方法？让结果说话。','Have an approach of your own? Put it to the test.')}</h2><p>${L('留下策略版本、测试记录和风险说明。奖励资格取决于质量审核，不按交易次数或一次盈利计算。','Keep the strategy version, tests and risks together. Reward eligibility depends on review, not trade counts or a single win.')}</p></div></div><div class="ux-advice-layout"><section class="ux-run-panel"><h2>${L('提交一份候选策略','Save a candidate strategy')}</h2><form id="contribution-form"><label class="p-field">${L('选择已检查的版本','Choose a checked version')}<select name="draft" required>${eligible.length?eligible.map(d=>`<option value="${d.id}">${e(strategyName(strategyById(d.strategy)||{id:d.strategy,name:d.name}))} · v${d.version}</option>`).join(''):`<option value="">${L('先完成一次策略检查','Complete a strategy check first')}</option>`}</select></label><label class="p-field">${L('什么情况下使用？什么时候停？','When should it run, and when should it stop?')}<textarea name="note" required minlength="12" maxlength="600" rows="4" placeholder="${L('说明适用行情、退出条件，以及可能失效的情况','Describe suitable markets, exits and potential failures')}"></textarea></label><button class="p-button p-primary" ${eligible.length?'':'disabled'}>${L('保存贡献','Save contribution')}</button><p class="p-footnote">${L('模拟检查不等于回测通过。','A simulation check is not a backtest pass.')}</p></form></section><aside class="ux-run-panel"><h2>${L('奖励规则','Reward rules')}</h2><ol class="ux-review-steps"><li>${L('固定版本和测试记录','Keep a version and test record')}</li><li>${L('检查风险、成本和可复现性','Review risk, cost and reproducibility')}</li><li>${L('通过活动资格审核','Pass program eligibility review')}</li><li>${L('按已公布规则结算','Settle under published program rules')}</li></ol><p>${L('奖励金额和发放方式尚未公布。','Reward amounts and payouts have not been announced.')}</p><details class="ux-detail-rules"><summary>${L('贡献模型额度','Contribute model capacity')}</summary><p>${L('这是独立授权，当前未开放。使用自己的 Key 不等于同意让其他人使用。','This needs separate permission and is not available yet. Using your own key does not allow others to use it.')}</p></details></aside></div><section class="ux-run-panel"><h2>${L('我的记录','My records')} · ${records.length}</h2>${records.length?records.map(c=>`<article class="ux-contribution"><div><b>${e(strategyName(strategyById(c.strategy)||{id:c.strategy,name:c.strategy}))} · v${c.version}</b><p>${e(c.note)}</p><small>${e(c.id)} · ${e(c.validationId)}</small></div><span class="ux-pill">${L('待评估 · 本地记录','Pending assessment · local')}</span></article>`).join(''):`<div class="ux-empty">${L('暂无贡献记录','No contributions yet')}</div>`}</section></div>`;}
 function bind(root){root.querySelectorAll('[data-journey]').forEach(el=>el.onclick=async event=>{const a=el.dataset.journey;if(a==='answer'&&event?.detail>1)return;
  if(a==='answer'){if(!QUESTIONS[step].choices.some(c=>c[0]===el.dataset.id))return;answers[QUESTIONS[step].key]=el.dataset.id;persistAnswers();if(step<4)step++;else done=true;refresh();}
  if(a==='back'){step=Math.max(0,step-1);refresh();}
  if(a==='next'){if(!answers[QUESTIONS[step].key])return;if(step<4)step++;else done=true;refresh();}
  if(a==='revise'){done=false;step=0;resultFeedback='';resultIssue='';refresh();}
  if(['answer','back','next','revise'].includes(a)){const heading=root.querySelector('h1');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}root.scrollTop=0;}
  if(a==='apply'){const result=await applyRecommendation(w,answers);if(result.error){resultIssue=result.error;resultFeedback=result.message||L(...({answers:['请先完成五个问题。','Complete all five answers first.'],busy:['请先关闭正在等待的策略，或处理当前交易。','Stop watching or finish the current trade first.'],resource:['草稿未能保存，请检查账户状态或方案数量。你的回答已保留。','The draft could not be saved. Check account access or your saved-plan limit. Your answers are retained.']}[result.error]));refresh();return;}resultFeedback='';resultIssue='';if(onApply)onApply(result.draft.id);else route('strategies');}
  if(a==='copy-replay'){notify('Coming soon');return;const c=w.s.copyStrategy;if(!c)return;w.s.copyReplays||=[];const old=w.s.copyReplays.find(r=>r.version===c.version);if(old){notify(L('这个版本已有结果，直接查看，不再扣分。','This version has a result. No new charge.'));refresh();return;}const result=replayCopy(c.params),q=w.reserve('跟随规则演练',4,`COPY:v${c.version}`);if(q.error){notify(q.error);return;}w.settle(q.usage.id,3,'固定样例回放完成');const record={id:w.id('CP'),version:c.version,usageId:q.usage.id,points:q.usage.settled,result};w.s.copyReplays.unshift(record);w.notice('跟随样例已完成，可查看逐条处理结果。','copy',record.id);w.touch();refresh();}
 });
 const af=root.querySelector('#advisor-address');if(af)af.onsubmit=async ev=>{ev.preventDefault();const f=Object.fromEntries(new FormData(af));if(f.address&&!publicAddressValid(f.address,f.chain)){addressFeedback='invalid';refresh();return;}if(w.account){try{if(f.address.trim())await w.account.command('resource',{kind:'address',key:f.chain+':'+f.address.trim(),...(profileAddress?{replaceKey:profileChain+':'+profileAddress}:{})});else if(profileAddress)await w.account.resource('address',profileChain+':'+profileAddress,true);}catch(e){addressFeedback=e.message;refresh();return;}}profileAddress=f.address.trim();profileChain=f.chain;persistAnswers();addressFeedback=L('已保存在本机。历史分析等待数据接入。','Saved locally. History analysis awaits a data connection.');refresh();};
 const cf=root.querySelector('#copy-form');if(cf){const size=cf.querySelector('[name=sizing]'),market=cf.querySelector('[name=market]');const fields=()=>{cf.querySelector('[name=ratio]').closest('label').hidden=size.value==='fixed';cf.querySelector('[name=maxLeverage]').closest('label').hidden=market.value==='spot';};fields();cf.oninput=()=>{fields();const replay=root.querySelector('[data-journey=copy-replay]');if(replay){replay.disabled=true;replay.textContent=L('先保存修改','Save changes first');}};}if(cf)cf.onsubmit=ev=>{ev.preventDefault();const f=Object.fromEntries(new FormData(cf)),p={...f,followExit:f.followExit==='on'};for(const k of Object.keys(COPY_DEFAULTS))if(typeof COPY_DEFAULTS[k]==='number')p[k]=Number(f[k]);delete p.address;delete p.chain;
 if(copyConfigError(p)){notify(L('请检查金额：单笔不能超过单资产上限，单资产上限不能超过总资金。','Check the limits: entry ≤ per-asset cap ≤ total allocation.'));return;}
 if(f.address&&!publicAddressValid(f.address,f.chain)){notify(L('地址格式不对，请检查网络和完整地址。','Check the network and full address.'));return;}
 if(f.market==='spot'&&f.chain!=='solana'||f.market==='perp'&&f.chain!=='evm'){notify(L('现货样例请选择 Solana，合约样例请选择 EVM。','Choose Solana for spot fixtures or EVM for perpetual fixtures.'));return;}
 copy=p;copyAddress=f.address.trim();copyChain=f.chain;const old=w.s.copyStrategy,changed=JSON.stringify(old?.params)!==JSON.stringify(p)||old?.address!==copyAddress||old?.chain!==copyChain;w.s.copyStrategy={params:p,address:copyAddress,chain:copyChain,version:(old?.version||0)+(changed?1:0)};w.touch();copyFeedback=L('已保存。可以在右侧用样例检查一次。','Saved. Run the sample replay to check these rules.');refresh();};
 const contrib=root.querySelector('#contribution-form');if(contrib)contrib.onsubmit=ev=>{ev.preventDefault();const f=Object.fromEntries(new FormData(contrib)),d=w.draft(f.draft);if(!d||d.status!=='passed'||d.validatedVersion!==d.version||d.riskVersion!==w.s.risk.version)return;w.s.contributions||=[];if(w.s.contributions.some(c=>c.draftId===d.id&&c.version===d.version)){notify(L('这个版本已保存过，不重复提交。','This version already has a contribution record.'));return;}w.s.contributions.unshift({id:w.id('CT'),draftId:d.id,strategy:d.strategy,version:d.version,validationId:d.validationId,note:f.note.trim(),status:'pending',at:w.s.clock,snapshot:{amount:d.amount,cap:d.cap,mode:d.mode,risk:{...w.s.risk}}});w.touch();notify(L('贡献记录已保存，等待资格评估。','Contribution saved locally; eligibility is pending.'));refresh();};
 }
 return {render:page=>page==='advisor'?advisor():page==='copy-trading'?copyPage():page==='contributions'?contributions():null,bind,signals:()=>false?`<section class="ux-run-panel" data-localized-ui><div class="ux-section-title"><h2>${L('跟随策略 · 样例事件','Copy strategy · sample events')}</h2>${go('查看跟随规则','View copy rules','copy-trading')}</div><p>${L('独立的样例回放，不计入交易账户的委托与盈亏。','Separate fixture replay; excluded from account orders and P&L.')}</p></section>`+copyResults(w.s.copyReplays[0]):''};
}

// Strategy marketplace and local configuration drawer. Reuses WorkspaceSim and the single desk.
const SC_COPY={
 S03:['趋势跟随 · 均线与 RSI','Trend following · MA & RSI','趋势向上，再等动量确认。','Wait for momentum to confirm an upward trend.','trend'],
 S00:['多周期共振','Multi-timeframe alignment','先看大方向，再找合适的入场。','Align the broader trend before looking for an entry.','trend'],
 S01:['区间网格','Range grid','在设定区间内，分层买入与卖出。','Stage entries and exits within a fixed range.','range'],
 S02:['有限分批买入','Bounded scaling','最多三次买入，共用一个资金上限。','Up to three entries with one shared allocation limit.','range'],
 S04:['结构突破','Structure breakout','等回踩确认，再观察突破机会。','Look for a breakout after a confirmed pullback.','trend'],
 S05:['盘口短线','Order-book scalping','从短时买卖力量中寻找机会。','Watch short-term changes in buying and selling pressure.','range'],
 S06:['波浪延续','Wave continuation','回调之后，观察趋势能否继续。','Watch for trend continuation after a retracement.','trend'],
 S07:['价量确认','Price & volume confirmation','价格与成交量互相印证，再行动。','Wait for price and volume to confirm each other.','trend'],
 S08:['K 线突破','Inside-bar breakout','等待价格走出收敛区间。','Wait for price to break out of a narrowing range.','trend'],
 'S09-A':['链上价差','On-chain spreads','比较同链不同交易池的价差。','Compare price differences between pools on one chain.','chain'],
 'S09-L':['流动性管理','Liquidity management','管理流动性区间与持币比例。','Manage liquidity ranges and inventory.','chain'],
 RX01:['宏观事件跟踪','Macro event follow-through','消息落地后，看价格是否跟上。','Watch how price responds after an event.','event'],
 'RX02-P':['叙事热度跟踪','Narrative momentum','关注原始消息，也等现货确认。','Read original sources and wait for spot confirmation.','event'],
 'RX02-A':['社媒异动','Social attention shifts','从关注度变化里筛选新线索。','Screen changes in attention for useful leads.','event'],
 'RX03-S':['链上买卖力量','On-chain trade flow','观察真实成交，过滤普通转账。','Observe swaps while filtering ordinary transfers.','chain'],
 'RX03-B':['交易所资金变化','Exchange flow changes','结合资金去向与价格变化。','Read fund movements alongside price changes.','chain'],
 RX04:['解锁风险保护','Unlock-event protection','临近解锁时，先控制新增买入。','Limit new entries around token unlocks.','event'],
 RX05:['杠杆清理后观察','Post-liquidation recovery','清算降温后，等待现货企稳。','Wait for spot stability after liquidations ease.','event']
};
const scText=s=>SC_COPY[s.id]||[s.name,s.id,'按规则寻找机会。','Find opportunities under defined rules.','trend'];
export const strategyName=s=>L(...scText(s).slice(0,2));
export const strategyDescription=s=>L(...scText(s).slice(2,4));
const scBtn=(label,act,id='',primary=false,disabled=false)=>`<button type="${['check','start'].includes(act)?'submit':'button'}" ${['check','start'].includes(act)?'form="sc-config"':''} class="sc-button ${primary?'sc-primary':''}" data-sc="${act}" data-id="${e(id)}" ${disabled?'disabled':''}>${label}</button>`;
const scInfo=(label,text)=>`<details class="sc-info"><summary aria-label="${e(label)}">i</summary><span>${text}</span></details>`;
const FAMILY_ICONS={S00:'alignment',S01:'range',S02:'layers',S03:'trend',S04:'breakout',S05:'depth',S06:'wave',S07:'volume',S08:'candles','S09-A':'chain','S09-L':'liquidity',RX01:'calendar','RX02-P':'spark','RX02-A':'messages','RX03-S':'flow','RX03-B':'exchange',RX04:'shield',RX05:'unwind'};
const scIcon=kind=>`<svg viewBox="0 0 24 24" data-strategy-icon="${kind}" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({
 trend:'<path d="M3 18l5-5 4 2 8-10M16 5h4v4"/><path opacity=".4" d="M3 21h18"/>',
 range:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
 layers:'<path d="M4 5h6M4 12h11M4 19h16M17 4v8m-3-3 3 3 3-3"/>',
 alignment:'<path d="M3 5h7l3 3h8M3 12h7l3-3h8M3 19h7l3-6h8"/>',
 breakout:'<path opacity=".5" d="M3 9h12v12H3z" stroke-dasharray="3 3"/><path d="M5 17l5-4 3 2 7-12M16 3h4v4"/>',
 depth:'<path d="M3 5h6M3 10h8M3 15h5M3 20h9M21 5h-4M21 10h-7M21 15h-5M21 20h-8"/><path opacity=".4" d="M12 3v18"/>',
 wave:'<path d="M2 16l4-8 4 12 4-16 4 10 4-5"/>',
 volume:'<path d="M4 21v-7M9 21V9M14 21v-5M19 21V5M3 9l5-4 5 3 7-6"/>',
 candles:'<path d="M6 2v20m12-17v14M3 6h6v10H3zM15 9h6v6h-6z"/>',
 chain:'<path d="M9 15l-2 2a4.2 4.2 0 0 1-6-6l5-5a4.2 4.2 0 0 1 6 0m0 12a4.2 4.2 0 0 0 6 0l5-5a4.2 4.2 0 0 0-6-6l-2 2M8 16l8-8"/>',
 liquidity:'<path d="M12 2C9 7 5 10 5 15a7 7 0 0 0 14 0c0-5-4-8-7-13Z"/><path d="M8 16h8M10 12h4"/>',
 calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 2v6M17 2v6M3 10h18m-10 4h5m-5 4h3"/>',
 spark:'<circle cx="5" cy="18" r="2"/><circle cx="12" cy="9" r="2"/><circle cx="20" cy="4" r="2"/><path d="m6 16 5-5m3-3 4-3M4 4h3m-1-1v3"/>',
 messages:'<path d="M3 3h15v12H8l-5 4V3Zm5 5h5m-5 3h7M12 19h5l4 3V9"/>',
 flow:'<circle cx="4" cy="12" r="2"/><circle cx="20" cy="6" r="2"/><circle cx="20" cy="18" r="2"/><path d="M6 12h5l6-6m-6 6 6 6M14 6h3v3m-3 9h3v-3"/>',
 exchange:'<path d="M4 6h16m-4-4 4 4-4 4M20 18H4m4-4-4 4 4 4"/>',
 unwind:'<path d="M3 6h4v12H3zM10 3h4v13h-4zM17 8h4v6h-4zM6 21h15m-3-3 3 3-3 3"/>',
 event:'<path d="m14 2-9 12h7l-2 8 9-12h-7l2-8Z"/>',
 copy:'<rect x="8" y="7" width="13" height="15" rx="2"/><path d="M16 7V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h4m4-4 2 2 4-4"/>',
 shield:'<path d="m12 2 8 3v6c0 5-5 9-8 11-3-2-8-6-8-11V5l8-3Z"/><path d="m8 12 3 3 5-6"/>'
})[kind]||''}</svg>`;
export function simulationBoundary(source){
 const local=source==='LOCAL_SERVICE';
 return {notice:local?L('本机服务维持模拟运行；服务停止时保护不可用，重启后须核对。','The local service keeps the simulation running. Protection is unavailable while it is stopped; review after restart.'):L('关闭页面不会继续运行；刷新后须明确恢复原实例。','Closing the page stops execution. After refresh, explicitly resume the original instance.'),scope:local?L('本方案版本；仅限本机模拟服务','This plan version, local simulation service only'):L('本方案版本；本次页面模拟结束前有效','This plan version, until this browser simulation ends')};
}
export function strategyLaunchError(w,desk){
 const d=w.draft(),snapshot=desk.snapshot();
 if(!d)return L('请先保存策略设置。','Save the strategy settings first.');
 if(!strategyFlowAvailable(d))return L('此策略版本或标的尚未适配本地流程；可先保存研究方案。','This version or instrument has no simulation adapter. Save it as a research plan.');
 if(!d.executionRoute?.connectionId||!d.executionRoute.accountId||!d.market)return L('请先选择明确的交易接入与资产，再检查方案。','Choose a specific trading connection and instrument, then check the plan.');
 if(!strategyConnection(d.executionRoute,snapshot.connections))return L('原交易接入不可用或与方案不一致，请重新选择。','The bound connection is unavailable or does not match this plan. Choose it again.');
 const sync=desk.syncStatus?.(),access=desk.access?.({...strategyAccessOptions(d.executionRoute,d.mode),...(isBotSimulation(d)?{nativeBot:true}:{})});
 if(access&&!access.ready)return accessMessage(access);
 if(sync&&(sync.state!=='LIVE'||sync.scope?.accountId!==d.executionRoute.accountId||sync.scope?.environment!=='DEMO'))return L('请先恢复所选模拟账户的读取。','Restore the selected demo account feed first.');
 if(!['auto','signal'].includes(d.mode))return L('这是旧的逐笔确认设置。请选择批准方案后运行或只观察，再检查。','This legacy setup requires an execution mode update. Choose the approved plan or observe only, then check again.');
 if(!w.setupReady)return L('设置已变化或检查已过期，请重新检查。','Settings changed or the check expired. Check again.');
 if(w.s.scope==='tradfi')return L('当前仅研究 TradFi。请在设置里加入 Crypto 后再开启现货模拟。','Crypto must be included in your research scope before starting a spot simulation.');
 if(isBotSimulation(d))return w.checkStart({...d})||desk.botCreateError?.(d)||null;
 if(snapshot.discovery?.armed)return L('已有策略在等待机会，请先关闭等待。','Another strategy is watching for opportunities. Stop that watch first.');
 if(snapshot.session&&snapshot.state!=='stopped'||snapshot.position||snapshot.pending)return L('已有交易或持仓，请先到交易枢纽处理。','A run or position is already open. Manage it in Trading first.');
 return w.checkStart({...d},strategyAccessOptions(d.executionRoute,d.mode));
}
export function reconcileStrategyWatch(w,desk,d=w.draft()){
 const launch=d?.botLaunch,s=desk.snapshot();
 if(!launch)return L('尚未提交启动请求。','No start request has been submitted.');
 if(isBotSimulation(d)){const run=s.botBook?.runs?.find(run=>run.requestId===launch.requestId&&run.plan.id===d.id&&run.plan.version===d.version);if(run){launch.status=['stopped','failed','interrupted'].includes(run.status)?run.status:'started';launch.runId=run.id;w.s.started=true;w.touch();return null;}if(launch.status!=='unknown'){launch.status='unknown';w.touch();}return L('启动结果尚未确认，请查询原请求；不会重复启动。','The start result is unresolved. Check the original request; no duplicate start will be sent.');}
 const matches=receipt=>Boolean(launch.requestId&&d.executionRoute?.connectionId&&receipt?.requestId===launch.requestId&&receipt.draftId===d.id&&receipt.version===d.version&&receipt.connectionId===d.executionRoute.connectionId&&receipt.accountId===d.executionRoute.accountId);
 const session=matches(s.session)?s.session:null,current=matches(s.discovery)?s.discovery:null;
 const saved=matches(launch.receipt)?launch.receipt:null;
 const receipt=session?{...session,status:s.state==='stopped'&&!s.position&&!s.pending?'stopped':'started'}:['stopped','interrupted','failed'].includes(saved?.status)?saved:current||saved;
 if(receipt&&['stopped','interrupted','failed'].includes(receipt.status)){
  launch.status=receipt.status;launch.runId=session?.id||receipt.runId||null;if(w.s.selectedDraftId===d.id)w.s.setupPrecheckId=null;if(!s.discovery?.armed&&w.s.strategyCenterArmedDraftId===d.id)w.s.strategyCenterArmedDraftId=null;w.touch();return null;
 }
 if(receipt&&(receipt.status==='started'||current?.status==='watching'&&current.armed)){
  launch.status=receipt.status==='started'?'started':'accepted';launch.runId=session?.id||receipt.runId||null;w.s.strategyCenterArmedDraftId=d.id;w.s.started=true;w.touch();return null;
 }
 if(launch.status!=='unknown'){launch.status='unknown';w.touch();}
 return L('启动结果尚未确认，请查询原请求；不会重复启动。','The start result is unresolved. Check the original request; no duplicate start will be sent.');
}
const pendingLaunches=new WeakMap();
export function startStrategyWatch(w,desk,onResearchStart){
 const d=w.draft();
 if(d&&pendingLaunches.has(d))return pendingLaunches.get(d);
 if(d?.botLaunch&&(['requested','unknown'].includes(d.botLaunch.status)||['accepted','started'].includes(d.botLaunch.status)&&d.botLaunch.fingerprint===botPlanFingerprint(d)))return reconcileStrategyWatch(w,desk);
 const error=strategyLaunchError(w,desk);if(error)return error;
 const attempt=(d.botLaunch?.attempt||0)+1;
 d.botLaunch={requestId:`${d.id}:v${d.version}:${attempt}`,attempt,fingerprint:botPlanFingerprint(d),status:'requested',approvedAt:w.s.clock};
 w.touch();
 if(w.persistenceError){d.botLaunch.status='unsent';return L('草稿暂未保存，请恢复本机存储后再启动。','The draft could not be saved. Restore local storage before starting.');}
 const complete=gate=>{
  if(gate){d.botLaunch.status='unsent';w.touch();return gate;}
  const pending=reconcileStrategyWatch(w,desk,d);if(pending)return pending;onResearchStart?.();return null;
 };
 const unknown=()=>{d.botLaunch.status='unknown';w.s.strategyCenterArmedDraftId=d.id;w.touch();return L('启动结果尚未确认，请查询原请求；不会重复启动。','The start result is unresolved. Check the original request; no duplicate start will be sent.');};
 try{
  const approved=JSON.parse(JSON.stringify(d));if(!isBotSimulation(d))desk.configure(approved);
  const gate=isBotSimulation(d)?desk.createBot(approved):desk.arm(approved);
  if(gate&&typeof gate.then==='function'){
   const pending=gate.then(complete).catch(unknown).finally(()=>pendingLaunches.delete(d));pendingLaunches.set(d,pending);return pending;
  }
  return complete(gate);
 }catch{return unknown();}
}
function creditSummary(w,daily=strategySetupCosts(w).daily){
 const c=strategySetupCosts(w),price=value=>value===0?L('免费','Free'):`${value} ${L('AI 积分','AI credits')}`,free=c.check===0&&c.start===0;
 const automatic=Boolean(w.account?.s.preferences.autoEnabled);
 const row=(name,value)=>`<div><dt>${name}</dt><dd>${value}</dd></div>`;
 return `<section class="sc-credit-summary" aria-label="${L('积分费用','Credit costs')}"><header><h3>${L('积分费用','Credit costs')}</h3>${scInfo(L('什么时候用积分？','When are credits used?'),L('设置预算不会开启自动研究。补充研究会先确认费用；取消未完成的任务会退回暂占积分。','Setting a budget does not enable automatic research. Additional research asks you to confirm the cost; unfinished cancelled tasks release their holds.'))}</header><dl>${free?row(L('设置与启动','Setup & start'),price(0)):row(L('检查设置','Check settings'),price(c.check))+row(L('开始模拟','Start simulation'),price(c.start))}${row(L('单次补充研究上限','Additional research limit per task'),price(c.research))}</dl><details class="sc-credit-budget"><summary>${L('自动研究','Automatic research')} · ${automatic?L('已开启','On'):L('未开启','Off')}${uiGlyph('chevron')}</summary><dl>${row(L('自动研究','Automatic research'),automatic?L('已开启','On'):L('未开启','Off'))}${row(L('每日自动研究上限','Daily automatic research limit'),daily+' '+L('AI 积分','AI credits'))}</dl></details><footer><span>${L('可用积分','Available credits')}</span><b>${c.available} ${L('AI 积分','AI credits')}</b></footer></section>`;
}
export function strategySuggestions(w){
 const candidates=RESEARCH_STRATEGIES;
 return (w.research?.tasks||[]).filter(task=>candidates[task.symbol]&&w.research.accepts(task)).sort((a,b)=>(b.outcome==='candidate'&&b.phase==='complete')-(a.outcome==='candidate'&&a.phase==='complete')).slice(0,3).map(task=>({symbol:task.symbol,strategy:candidates[task.symbol],title:task.title,reason:task.thesis,phase:task.phase,outcome:task.outcome,revision:w.research.revision(task),available:strategyFlowAvailable({strategy:candidates[task.symbol],market:task.symbol+'/USDT'}),ready:task.phase==='complete'&&task.outcome==='candidate'}));
}
export function createStrategyCenter({w,desk,root,go:route,refresh,notify,onResearchStart,onRecommendationSource,openPage,readQuote=readTradingChartQuote}){
 let catalogView='templates',compareOnly=false,group='all',query='',onlyReady=false,marketScope='all',marketTime='all',marketSort='default',productFilter='',marketFiltersOpen=false,mineFilter='all',opened=null,phase='overview',feedback='',feedbackTone='error',amount=100,cap=500,mode='auto',stamp='',age=0,opener=null,protection=protectionConfig(),riskScene='normal',researchBudget=strategySetupCosts(w).daily,planTab='plan',planScenario='A',memoryView=null,memoryToken=0;
 let returnToCaller=null,instrumentDialog=null,recommendationNotice=null,editExitDialog=null;
 let workspaceSelection='S01',inlineHost=null,pendingEditor=null,workspaceSource=null,openingPage=false;
 const visitedEditors=new Set();
 const drawer=document.createElement('dialog');drawer.className='sc-drawer';drawer.setAttribute('data-localized-ui','');drawer.setAttribute('aria-labelledby','sc-drawer-title');document.body.append(drawer);
 const expandedDrafts=new Set();let configView='quick',mobileView='settings',viewScroll={},gridPreviews={},disposeBotCharts=()=>{},executionRoute=null,submission=null,settingsReturn=null,botParameters={},botParameterSets={},parameterSource='recommended',parameterReference=null,liveParameterQuote=null,checkedParameterQuote=null,simulationReference=null,endRunId=null;
 const artObserver=createStrategyArtMotion();
 const workspaceHost=container=>document.body.dataset?.page==='strategies'?container.querySelector('[data-strategy-workspace-host]'):null;
 const editorScope=()=>JSON.stringify([w.account?.scope||'local',w.s.setupContext?.accountId,w.s.setupContext?.environment]);
 const editFingerprint=()=>botPlanFingerprint({...nativePlan(),mode:nativeEditor()?mode:'signal'})+JSON.stringify([Number(researchBudget),parameterSource,parameterReference]);
 function snapshotEditorAlias(context,buffers){const key=context.id+':draft:'+context.draftId;if(!context.draftId||[context.id,key].includes(context.editorKey||context.id))return null;const restore=structuredClone(buffers[key]||null);return {key,restore,expected:structuredClone(restore)};}
 const aliasMatches=(alias,buffers)=>!alias||[alias.expected,...(alias.pending?[alias.pending]:[])].some(value=>JSON.stringify(buffers[alias.key]||null)===JSON.stringify(value));
 function acceptEditor(){if(!opened||w.persistenceError)return;const buffers=loadBotEditors(w);opened.exitBaseline=editFingerprint();opened.exitBuffer=structuredClone(buffers[opened.editorKey||opened.id]||null);opened.exitAlias=snapshotEditorAlias(opened,buffers);}
 function beforeLeave(){
  if(openingPage||!opened||!drawer.open||opened.exitDiscarded)return null;
  if(submission&&submission===opened)return L('正在保存或确认启动，请稍候再离开。','Saving or confirming the launch. Wait before leaving.');
  if(opened.editorScope!==editorScope())return L('账户已变化，当前输入仍保留。请返回原账户后继续。','The account changed. Your inputs are retained. Return to the original account to continue.');
  if(!['configure','overview'].includes(phase))return null;
  if(!capture())remember();
  return w.persistenceError?L('配置尚未确认缓存，当前输入仍保留。请检查浏览器存储后重试。','The setup cache could not be confirmed. Your inputs are retained. Check browser storage and try again.'):null;
 }
 function requestExit(leave){
  if(submission&&submission===opened){paintSubmission();return false;}
  if(!opened||!drawer.open||phase!=='configure'){leave();return true;}
  if(opened.editorScope!==editorScope()){feedback=L('账户已变化，当前输入仍保留。请返回原账户后继续。','The account changed. Your inputs are retained. Return to the original account to continue.');feedbackTone='error';renderDrawer();return false;}
  capture();
  if(editFingerprint()===opened.exitBaseline){leave();return true;}
  if(editExitDialog?.open)return false;
  const context=opened,key=context.editorKey||context.id,identity=sourceEditorKey(context.id,context.source),previous=document.activeElement,dialog=document.createElement('dialog');let leaving=false;
  editExitDialog=dialog;dialog.className='sc-instrument-picker sc-edit-exit';dialog.setAttribute('data-localized-ui','');dialog.setAttribute('aria-labelledby','sc-edit-exit-title');dialog.setAttribute('aria-describedby','sc-edit-exit-description');
  dialog.innerHTML=`<header><h2 id="sc-edit-exit-title">${L('离开前，如何处理本次编辑？','How would you like to leave?')}</h2><button type="button" class="sc-instrument-close" data-edit-exit="continue" aria-label="${L('继续编辑','Continue editing')}">${uiGlyph('close')}</button></header><div class="sc-instrument-body"><p id="sc-edit-exit-description">${L('保留后，下次可从当前配置继续。放弃只撤回本次编辑，打开前的草稿和已有运行不受影响。','Keep your setup to continue later. Discard only reverts this editing session; earlier drafts and existing runs stay unchanged.')}</p><p class="sc-edit-exit-error" role="alert"></p><footer><button type="button" class="p-button" data-edit-exit="discard">${L('放弃本次编辑','Discard these edits')}</button><button type="button" class="p-button" data-edit-exit="continue">${L('继续编辑','Continue editing')}</button><button type="button" class="p-button p-primary" data-edit-exit="keep">${L('保留并返回','Keep & return')}</button></footer></div>`;
  const fail=message=>{const note=dialog.querySelector('.sc-edit-exit-error');if(note)note.textContent=message;};
  dialog.addEventListener('click',event=>{
   const choice=event.target.closest('[data-edit-exit]')?.dataset.editExit;if(!choice)return;
   if(choice==='continue'){dialog.close();return;}
   if(submission||opened!==context||context.editorScope!==editorScope()||(context.editorKey||context.id)!==key||sourceEditorKey(context.id,context.source)!==identity){fail(L('编辑或账户已变化，请继续编辑并重新核对。','The editor or account changed. Continue editing and review it again.'));return;}
   const buffers=loadBotEditors(w),current=buffers[key],alias=context.exitAlias;
   if(!current||current.id!==context.id||sourceEditorKey(context.id,current.source)!==identity){fail(L('草稿已变化，请继续编辑并重新核对。','The draft changed. Continue editing and review it again.'));return;}
   if(!aliasMatches(alias,buffers)){fail(L('原草稿已在其它编辑中更新，当前输入仍保留。请重新核对。','The original draft changed in another editor. Your inputs are retained. Review it again.'));return;}
   const saved=choice==='keep'?remember():clearBotEditor(w,key,context.exitBuffer,current,alias?{key:alias.key,restore:alias.restore,expected:buffers[alias.key]||null}:null);
   if(!saved){fail(L('更改尚未确认保存，当前输入仍保留。请检查浏览器存储后重试。','Changes could not be confirmed saved. Your inputs are retained. Check browser storage and try again.'));return;}
   if(choice==='discard')context.exitDiscarded=true;
   leaving=true;dialog.close();leave();
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();dialog.close();});
  dialog.addEventListener('close',()=>{dialog.remove();if(editExitDialog===dialog)editExitDialog=null;if(!leaving){if(previous?.isConnected)previous.focus();else drawer.querySelector('#sc-config input,[data-sc="close"]')?.focus();}},{once:true});
  document.body.append(dialog);dialog.showModal();dialog.querySelector('footer [data-edit-exit="continue"]')?.focus();return false;
 }

 function placeEditor(host){
  if(instrumentDialog?.open)instrumentDialog.close();
  if(Boolean(host)!==Boolean(inlineHost)&&drawer.open)drawer.close();
  inlineHost=host;drawer.classList.toggle('sc-inline-drawer',Boolean(host));drawer.setAttribute('role',host?'region':'dialog');
  const parent=host||document.body;if(drawer.parentElement!==parent)parent.append(drawer);
 }
 function editorScrollElement(){
  if(inlineHost&&matchMedia('(max-width:767px)').matches)return root;
  return drawer.querySelector(inlineHost?(mobileView==='market'?'.bot-creation-market':'.bot-settings-scroll'):'.sc-drawer-body');
 }
 function renderCapability(item){
  disposeBotCharts();drawer.dataset.phase='candidate';drawer.dataset.family='';
  const saved=(w.s.botCatalogSelections||[]).includes(item.id),kind=L(item.kind==='execution'?'执行方式 · 待接入':'研究候选',item.kind==='execution'?'Execution method · unavailable':'Research candidate');
  drawer.innerHTML=botCreationFrame({content:sourceNotice(workspaceSource)+(returnToCaller?scBtn(L(opened?.source||workspaceSource?'返回来源':'返回列表',opened?.source||workspaceSource?'Back to source':'Back to list'),'return-source'):'')+'<article class="sw-candidate-details"><span class="sc-tag">'+kind+'</span><h3>'+L(...item.scope)+'</h3><p>'+e(L(...item.detail))+'</p></article>',view:null,mobileView,embedded:{header:'<div class="sc-drawer-head"><div><h2 id="sc-drawer-title">'+e(L(...item.name))+'</h2><span class="bot-editor-status">'+kind+'</span></div></div>',footer:'<footer class="sc-drawer-footer">'+scBtn(L(saved?'已保存候选':'保存候选',saved?'Candidate saved':'Save candidate'),'save-candidate',item.id,true,saved)+'</footer>',details:'',empty:'<div class="bot-market-empty">'+scIcon(marketplaceTypeIcon(item.id))+'<h3>'+e(L(...item.name))+'</h3><p>'+L('此策略版本或标的尚未适配本地流程；可先保存研究方案。','This version or instrument has no simulation adapter. Save it as a research plan.')+'</p></div>'}});
  if(!drawer.open){if(inlineHost)drawer.show();else drawer.showModal();}
 }

 const observeArt=host=>host.querySelectorAll('.strategy-art').forEach(el=>{if(!el.closest('.mp-card-chart'))artObserver.observe(el);});
 const info=()=>L('当前使用固定信号和模拟成交。检查的是设置与操作流程，尚无真实回测收益。','Uses scripted signals and simulated fills. Checks cover setup and workflow, not historical strategy returns.');
 const activeId=()=>{const s=desk.snapshot();return s.discovery?.armed?s.discovery.draftId||null:s.session&&(s.state!=='stopped'||s.position||s.pending)?s.session.draftId:null;};
 const status=d=>{const s=desk.snapshot(),run=s.botBook?.runs?.findLast(run=>run.plan.id===d.id);if(run)return [botInstanceStatus(run.status),botInstanceStatus(run.status),['running','waiting'].includes(run.status)?'live':['paused','interrupted','blocked'].includes(run.status)?'paused':'saved'];if(['requested','unknown'].includes(d.botLaunch?.status))return ['启动待确认','Start unconfirmed','check'];if(['stopped','interrupted','failed'].includes(d.botLaunch?.status)&&activeId()!==d.id)return d.botLaunch.status==='stopped'?(d.botLaunch.runId||d.botLaunch.receipt?.runId?['已结束','Ended','saved']:['观察已关闭','Watch stopped','saved']):d.botLaunch.status==='failed'?['启动未完成','Start failed','saved']:['观察已中断','Watch interrupted','saved'];if(s.discovery?.armed&&activeId()===d.id)return ['等待机会','Watching for opportunities','live'];if(s.session?.draftId===d.id&&(s.state!=='stopped'||s.position||s.pending))return s.state==='running'?['模拟运行中','Simulation running','live']:['已暂停买入','Entries paused','paused'];if(!isBotSimulation(d))return ['研究方案','Research plan','research'];return d.status==='validating'?['检查中','Checking','check']:['已保存设置','Settings saved','saved'];};
 const lock=()=>{feedbackTone='error';const s=desk.snapshot();if(s.discovery?.armed){feedback=L('已有策略在等待机会。先在“我的交易”关闭等待，再修改。','A strategy is watching for opportunities. Stop watching in My trading before editing.');return true;}if(s.session&&s.state!=='stopped'||s.position||s.pending){feedback=L('还有交易、持仓或未完成的订单。先到交易枢纽处理，再启用新的设置。','A run, position or pending order is still open. Finish it in Trading before changing the active setup.');return true;}return false;};
 const routeAccess=()=>{const access=desk.access?.({...strategyAccessOptions(executionRoute,mode),...(nativeEditor()?{nativeBot:true}:{})});return executionRoute?.connectionId&&!strategyConnection(executionRoute,desk.snapshot()?.connections)?{...access,connectionId:executionRoute.connectionId,ready:false,code:'connection-missing'}:access;};
 function invalidateCheck(draftId=opened?.draftId){checkedParameterQuote=null;simulationReference=null;const d=draftId?w.draft(draftId):null;if(!d)return;const validation=w.s.validations.find(v=>v.id===d.validationId);if(validation?.status==='running')w.cancelValidation(validation.id);if(w.s.selectedDraftId===d.id)w.s.setupPrecheckId=null;}
 function remember(){
  if(!opened||!executionRoute||!['configure','overview'].includes(phase))return;
  if(opened.exitDiscarded)return true;
  if(opened.editorScope!==editorScope())return false;
  viewScroll[mobileView]=editorScrollElement()?.scrollTop||0;
  if(nativeEditor())botParameterSets[botGridPreviewKey(executionRoute,opened.variant)]={parameters:{...botParameters},source:parameterSource,reference:parameterReference};
  const buffers=loadBotEditors(w),alias=opened.exitAlias,aliasChanged=!aliasMatches(alias,buffers),localSaved=buffers[opened.editorKey||opened.id]?.localSaved;
  const saved=!aliasChanged&&saveBotEditor(w,{id:opened.id,draftId:opened.draftId||null,baseVersion:opened.draftId?w.draft(opened.draftId)?.version:null,variant:opened.variant,amount,cap,mode,protection,researchBudget,executionRoute,mobileView,viewScroll,gridPreviews,botParameters,botParameterSets,parameterSource,parameterReference,...(simulationReference?{simulationReference}:{}),source:opened.source||null,previousEditorKey:opened.previousEditorKey||null,...(localSaved?{localSaved}:{})},opened.editorKey||opened.id);
  if(aliasChanged)w.persistenceError='原草稿已在其它编辑中更新，请重新核对。';
  if(alias&&!aliasChanged){const written=structuredClone(w.s.botEditors[alias.key]||null);if(saved){alias.expected=written;delete alias.pending;}else alias.pending=written;}
  const status=drawer.querySelector('.bot-editor-status');if(status){status.textContent=L(saved?'编辑已缓存':'缓存未完成',saved?'Edits cached':'Cache incomplete');status.setAttribute('role',saved?'status':'alert');}
  return saved;
 }
 const nativeNames=()=>Object.fromEntries(CATALOG.map(item=>[item.id,strategyName(item)]));
 const activeNative=d=>desk.snapshot().botBook?.runs?.some(run=>run.plan?.id===d.id&&!['stopped','failed'].includes(run.status));
 const nativeEditor=()=>isBotSimulation({strategy:opened?.id,planVariant:opened?.variant});
 const nativePlan=()=>{const plan={id:opened?.draftId||'editor:'+opened?.id,version:opened?.draftId?w.draft(opened.draftId)?.version||1:1,strategy:opened?.id,planVariant:opened?.variant,amount:Number(amount),cap:Number(cap),mode,protection,market:executionRoute?.market,executionRoute,...(simulationReference?{simulationReference}:{}),botParameters:Object.fromEntries(Object.entries(botParameters).filter(([,v])=>v!==''&&v!==undefined).map(([k,v])=>[k,k==='spacing'?v:Number(v)]))};if(amount==='')plan.amount=botBudgetAmount(plan)??0;return plan;};
 const nativeParameterSummary=()=>botParameterRows(nativePlan()).slice(0,opened.id==='S01'?2:3).map(([label,value])=>`<span>${label}<b>${value}</b></span>`).join('');
 function loadBotParameters(){const saved=botParameterSets[botGridPreviewKey(executionRoute,opened.variant)];botParameters=saved?.parameters?{...saved.parameters}:{};parameterSource=saved?.source||'recommended';parameterReference=saved?.reference||null;liveParameterQuote=null;checkedParameterQuote=null;simulationReference=null;}
 function applyExecutionRoute(next){
  if(next.market&&!strategyRouteValid(opened.id,next))return false;
  if(JSON.stringify(next)!==JSON.stringify(executionRoute))invalidateCheck();
  const sameMarket=['market','venueId','profileId','chainId'].every(key=>next[key]===executionRoute[key]);
  if(nativeEditor()&&sameMarket&&!botParameterSets[botGridPreviewKey(next,opened.variant)])botParameterSets[botGridPreviewKey(next,opened.variant)]={parameters:{...botParameters},source:parameterSource,reference:parameterReference};
  executionRoute=next;if(nativeEditor())loadBotParameters();feedback='';remember();renderDrawer();loadStrategyMemory();return true;
 }
 function mobileInstrument(){
  const venue=strategyVenues(executionRoute.profileId).find(v=>v.id===executionRoute.venueId);
  return `<button type="button" class="sc-instrument-mobile" data-sc="choose-instrument" aria-haspopup="dialog" aria-label="${L('选择交易对象','Choose instrument')}"><span>${executionRoute.market?tokenIcon(executionRoute.market.split('/')[0],{size:24}):uiGlyph('search')}<b>${e(executionRoute.market||L('选择交易对象','Choose instrument'))}</b></span><span>${e(venue?.name||executionRoute.venueId)}${uiGlyph('chevron')}</span></button>`;
 }
 function chooseInstrument(){
  if(!opened||phase!=='configure'||instrumentDialog?.open)return;
  capture();remember();const context=opened,previous=document.activeElement,dialog=document.createElement('dialog');let pending={...executionRoute},search='';
  instrumentDialog=dialog;dialog.className='sc-instrument-picker';dialog.setAttribute('aria-labelledby','sc-instrument-title');dialog.setAttribute('data-localized-ui','');
  const profiles=strategyMarkets(context.id),networks=()=>WALLET_NETWORKS.filter(n=>context.id.startsWith('S09')?n.id==='1':n.id==='56');
  const choices=()=>[...new Set([...(pending.profileId===executionRoute.profileId&&pending.venueId===executionRoute.venueId&&pending.chainId===executionRoute.chainId?[executionRoute.market]:[]),...routeAssets(pending)])].filter(Boolean);
  const allowed=market=>!nativeEditor()||Object.hasOwn(BOT_MARKETS,market);
  const selected=market=>market===executionRoute.market&&['profileId','venueId','chainId'].every(key=>pending[key]===executionRoute[key]);
  const rows=()=>{
   const found=choices().filter(m=>m.toLowerCase().includes(search.trim().toLowerCase()));
   const tracked=nativeEditor()?found.filter(m=>allowed(m)&&(w.s.aiSignalWatch||[]).some(key=>sameWatchAssetKey(key,m.split('/')[0]))):[];
   const option=m=>`<button type="button" role="option" data-instrument-pair="${e(m)}" aria-selected="${selected(m)}" ${allowed(m)?'':'disabled'}>${tokenIcon(m.split('/')[0],{size:28})}<strong>${e(m)}</strong><span>${allowed(m)?selected(m)?uiGlyph('check'):'':L('仅研究','Research only')}</span></button>`;
   if(!found.length)return `<p class="sc-instrument-empty" role="status">${L('未找到交易对','No matching pairs')}</p>`;
   if(!tracked.length)return found.map(option).join('');
   return [[L('我的追踪','My watchlist'),tracked],[L('其它品种','Other pairs'),found.filter(m=>!tracked.includes(m))]].filter(([,items])=>items.length).map(([label,items])=>`<div class="sc-instrument-group" role="group" aria-label="${label}"><span class="sc-instrument-group-label" aria-hidden="true">${label}</span>${items.map(option).join('')}</div>`).join('');
  };
  function render(focus){
   const profile=STRATEGY_MARKETS.find(p=>p.id===pending.profileId);
   dialog.innerHTML=`<header><h2 id="sc-instrument-title">${L('选择交易对象','Choose instrument')}</h2><button type="button" class="sc-instrument-close" data-instrument-close aria-label="${L('关闭','Close')}">${uiGlyph('close')}</button></header><div class="sc-instrument-body">${profiles.length>1?`<div class="sc-instrument-profiles" role="group" aria-label="${L('交易市场','Market')}">${profiles.map(id=>{const p=STRATEGY_MARKETS.find(p=>p.id===id);return `<button type="button" data-instrument-profile="${id}" aria-pressed="${id===pending.profileId}">${L(p.zh,p.en)}</button>`;}).join('')}</div>`:`<span class="sc-instrument-scope">${L(profile.zh,profile.en)}</span>`}<div class="sc-instrument-venues" role="group" aria-label="${L('交易平台','Trading venue')}">${strategyVenues(pending.profileId).map(v=>`<button type="button" data-instrument-venue="${v.id}" aria-pressed="${v.id===pending.venueId}">${venueIcon(v.id,{size:22})}<span>${e(v.name)}</span></button>`).join('')}</div>${pending.profileId.startsWith('dex')?`<label class="sc-instrument-network">${L('网络','Network')}<select data-instrument-chain aria-label="${L('网络','Network')}">${networks().map(n=>`<option value="${n.id}" ${n.id===pending.chainId?'selected':''}>${e(n.name)}</option>`).join('')}</select></label>`:''}<label class="sc-instrument-search">${uiGlyph('search')}<input type="search" data-instrument-search autocomplete="off" aria-label="${L('搜索交易对','Search trading pairs')}" placeholder="${L('搜索交易对','Search trading pairs')}" value="${e(search)}"></label><div class="sc-instrument-results" role="listbox" aria-label="${L('交易资产','Trading pair')}">${rows()}</div></div>`;
   dialog.querySelector(focus||'[data-instrument-search]')?.focus();
  }
  dialog.addEventListener('click',event=>{
   const b=event.target.closest('button');if(!b||!dialog.contains(b))return;
   if(b.hasAttribute('data-instrument-close')){dialog.close();return;}
   if(b.dataset.instrumentProfile){const id=b.dataset.instrumentProfile;if(!profiles.includes(id))return;const bscSpot=id==='dex-spot'&&!context.id.startsWith('S09');pending={...pending,profileId:id,venueId:bscSpot?'pancakeswap':strategyVenues(id)[0].id,chainId:id.startsWith('dex')?context.id.startsWith('S09')?'1':bscSpot?'56':'1':''};render(`[data-instrument-profile="${id}"]`);return;}
   if(b.dataset.instrumentVenue){const id=b.dataset.instrumentVenue;if(!strategyVenues(pending.profileId).some(v=>v.id===id))return;pending.venueId=id;render(`[data-instrument-venue="${id}"]`);return;}
   const market=b.dataset.instrumentPair;if(!market||!choices().includes(market)||!allowed(market)||opened!==context||phase!=='configure'||submission)return;
   const next={...pending,market};if(['venueId','profileId','chainId'].some(key=>next[key]!==executionRoute[key])){next.accountId='';next.connectionId='';}
   if(!strategyRouteValid(context.id,next))return;dialog.close();applyExecutionRoute(next);
  });
  dialog.addEventListener('input',event=>{if(!event.target.hasAttribute('data-instrument-search'))return;search=event.target.value;dialog.querySelector('.sc-instrument-results').innerHTML=rows();});
  dialog.addEventListener('change',event=>{if(!event.target.hasAttribute('data-instrument-chain')||!networks().some(n=>n.id===event.target.value))return;pending.chainId=event.target.value;render('[data-instrument-chain]');});
  dialog.addEventListener('keydown',event=>{
   if(event.key==='Escape'){event.preventDefault();dialog.close();return;}
   const searchTarget=event.target.hasAttribute('data-instrument-search');if(!(searchTarget?event.key==='ArrowDown':event.target.hasAttribute('data-instrument-pair')&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)))return;
   const options=[...dialog.querySelectorAll('[data-instrument-pair]:not(:disabled)')],i=options.indexOf(document.activeElement);if(!options.length)return;event.preventDefault();options[event.key==='Home'||searchTarget?0:event.key==='End'?options.length-1:Math.max(0,Math.min(options.length-1,i+(event.key==='ArrowDown'?1:-1)))]?.focus();
  });
  dialog.addEventListener('close',()=>{dialog.remove();if(instrumentDialog===dialog)instrumentDialog=null;if(previous?.isConnected)previous.focus();else drawer.querySelector('.trading-chart-instrument,.sc-instrument-mobile')?.focus();},{once:true});
  document.body.append(dialog);render();dialog.showModal();dialog.querySelector('[data-instrument-search]')?.focus();
 }
 function currentBotQuote(){
  const quote=desk.parameterQuote?desk.parameterQuote(executionRoute):readQuote(drawer.querySelector('[data-trading-chart="strategy-create-market"]'));
  if(botRecommendationIssue({market:executionRoute.market,executionRoute},null,quote))throw Error('MARKET_NOT_READY');
  return quote;
 }
 const quoteMessage=code=>code==='DEFAULT_RANGE_STALE'?L('现价已超出推荐区间，请更新推荐参数或手动设置。','The market is outside the recommended range. Update the recommendation or set your own range.'):L('行情暂不可用或已过期，请刷新后重新检查。','Market data is unavailable or stale. Refresh it and check again.');
 function updateQuoteControls(quote){
  const card=drawer.querySelector('.bot-recommendation'),reference=parameterReference?.closedPrice||quote?.closedPrice;
  if(card){card.querySelector('small').textContent=L('参考价','Reference price')+' '+(Number.isFinite(reference)?formatTradingPrice(reference)+' '+(executionRoute.market?.split('/')[1]||'USDT'):'—');card.querySelector('p').textContent=desk.parameterQuote?L('本机合成报价；行情图仅作参考，成交由独立模拟服务处理。','Local synthetic quote. The market chart is for reference; the isolated simulator handles execution.'):quote?(parameterReference?L('依据已收盘 K 线','Based on a closed candle')+' · '+formatDataTime(parameterReference.closedAt):L('可按当前行情重新生成，现有参数保持不变。','Reapply current market data to replace the existing parameters.')):L('等待所选资产的行情，或切换手动设置。','Wait for the selected market, or enter parameters manually.');card.querySelector('button').disabled=!quote;}
  const editablePlan=nativePlan();delete editablePlan.simulationReference;
  const note=drawer.querySelector('[data-bot-range-note]'),issue=parameterReference?botRecommendationIssue(editablePlan,parameterReference,quote):null;
  if(note)note.textContent=issue?quoteMessage(issue):'';
 }
 function applyBotQuote(quote){
  botParameters=recommendedBotParameters(opened.id,quote.closedPrice);parameterSource='recommended';parameterReference={...quote};checkedParameterQuote=null;
  for(const [key,value]of Object.entries(botParameters)){const field=drawer.querySelector('[name="bot_'+key+'"]');if(field)field.value=String(value);}
  refreshNumberInputs(drawer);
  feedback='';feedbackTone='info';const note=drawer.querySelector('.sc-feedback');if(note){note.textContent='';note.setAttribute('role','status');}
  invalidateCheck();remember();updateBotPreview();updateQuoteControls(quote);
 }
 function botChartIdentity(){return nativeEditor()&&strategyRouteValid(opened.id,executionRoute)&&strategyConnection(executionRoute,desk.snapshot()?.connections)?{accountId:executionRoute.accountId,connectionId:executionRoute.connectionId,venueId:executionRoute.venueId,environment:'DEMO',market:executionRoute.market,marketType:'SPOT',profileId:executionRoute.profileId,instrumentId:executionRoute.venueId+':SPOT:'+executionRoute.market,clockKind:'market'}:null;}
 function updateBotPreview(){if(!nativeEditor())return;const plan=nativePlan(),funding=drawer.querySelector('[data-bot-funding]'),required=botRequiredCapital(plan);if(funding){funding.textContent=executionRoute.market&&Number.isFinite(required)&&required>0?(amount===''?L('按预算分配','Sized from allocation')+' · '+amountFormat(plan.amount)+' USDT · ':'')+L('计划买入及手续费','Planned entries & fees')+' · '+amountFormat(required)+' USDT':'';funding.classList.toggle('is-invalid',Number.isFinite(required)&&required>Number(cap));}const summary=drawer.querySelector('[data-bot-parameter-summary]');if(summary)summary.innerHTML=nativeParameterSummary();const preview=drawer.querySelector('[data-bot-plan-preview]');if(preview)preview.innerHTML=executionRoute.market&&Object.keys(botParameters).length?botParameterFacts(nativePlan()):'';const identity=botChartIdentity();if(identity)disposeBotCharts.updateDraft?.('strategy-create-market',{identity,planRef:{id:opened.draftId||'editor:'+opened.id,version:opened.draftId?w.draft(opened.draftId)?.version||1:'unsaved'},gridPlan:gridPreviewPlan()});}
 function gridPreviewPlan(){
  if(nativeEditor()){if(opened.id!=='S01')return null;const p=nativePlan().botParameters;return {lower:p.lower,upper:p.upper,count:p.count,mode:p.spacing};}
  const p=botGridPreview(gridPreviews,executionRoute,opened.variant);
  return p?.applied?{lower:Number(p.lower),upper:Number(p.upper),count:Number(p.count),mode:p.mode}:null;
 }
 function mountBotCharts(){
  const host=drawer.querySelector('[data-tc-grid]')?.closest('[data-trading-chart]'),preview=botGridPreview(gridPreviews,executionRoute,opened.variant);
  if(host&&preview){host.querySelectorAll('[data-tc-grid]').forEach(input=>{input.value=preview[input.dataset.tcGrid];});refreshNumberInputs(host);}
  const dispose=mountCharts(drawer),events=new AbortController(),context=opened,key=botGridPreviewKey(executionRoute,opened.variant),marketHost=drawer.querySelector('[data-trading-chart="strategy-create-market"]');
  const cleanup=()=>{events.abort();dispose();};cleanup.updateDraft=dispose.updateDraft;
  marketHost?.addEventListener('trading-chart:choose-instrument',()=>action({dataset:{sc:'choose-instrument'}}),{signal:events.signal});
  if(nativeEditor()&&marketHost&&phase==='configure'){
   const changed=()=>{
    if(opened!==context||phase!=='configure'||key!==botGridPreviewKey(executionRoute,opened.variant))return;
    try{liveParameterQuote=currentBotQuote();}catch{liveParameterQuote=null;}
    if(liveParameterQuote&&parameterSource==='recommended'&&!Object.entries(botParameters).some(([key,value])=>key!=='spacing'&&value!==''&&value!==undefined)){const unchanged=editFingerprint()===opened.exitBaseline;applyBotQuote(liveParameterQuote);if(unchanged)opened.exitBaseline=editFingerprint();}
    else updateQuoteControls(liveParameterQuote);
   };
   marketHost.addEventListener('trading-chart:state',changed,{signal:events.signal});changed();
  }
  if(!host)return cleanup;
  const inputs=()=>Object.fromEntries([...host.querySelectorAll('[data-tc-grid]')].map(input=>[input.dataset.tcGrid,input.value]));
  const save=applied=>{gridPreviews[key]={...inputs(),applied};remember();};
  const changed=event=>{if(!event.target.dataset.tcGrid)return;save(false);host.querySelector('.trading-grid-feedback').textContent=L('参数已修改，重新预览后更新图层。','Inputs changed. Preview again to update the overlay.');};
  host.addEventListener('input',changed,{signal:events.signal});host.addEventListener('change',changed,{signal:events.signal});
  host.addEventListener('click',event=>{const action=event.target.closest('[data-tc-action]')?.dataset.tcAction;if(action==='grid-apply')save(host.dataset.gridState==='preview');if(action==='grid-clear'){delete gridPreviews[key];remember();}},{signal:events.signal});
  if(preview){host.querySelector('.trading-grid-feedback').textContent=L('已恢复预览参数，未创建订单。','Preview inputs restored. No orders created.');if(preview.applied)host.querySelector('.trading-grid-summary').textContent=`${preview.lower} – ${preview.upper} · ${preview.count}`;}
  return cleanup;
 }

 function sourceSnapshot(value){
  if(!value||!['research','signal'].includes(value.type)||!['string','number'].includes(typeof value.id)||!String(value.id).trim()||String(value.id).length>512)throw Error('SOURCE_INVALID');
  if(value.revision!=null&&!['string','number'].includes(typeof value.revision))throw Error('SOURCE_INVALID');
  if(typeof value.id==='number'&&!Number.isFinite(value.id)||typeof value.revision==='number'&&!Number.isFinite(value.revision))throw Error('SOURCE_INVALID');
  if(value.recordedAt!=null&&!['string','number'].includes(typeof value.recordedAt)||typeof value.recordedAt==='number'&&!Number.isFinite(value.recordedAt))throw Error('SOURCE_INVALID');
  if(value.recommendationId!==undefined&&(typeof value.recommendationId!=='string'||!value.recommendationId||value.recommendationId.length>2048))throw Error('SOURCE_INVALID');
  const input=value.instrument??(typeof value.symbol==='string'?{symbol:value.symbol}:{});
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('SOURCE_INVALID');
  for(const key of ['id','symbol','market','chainId','ca','address','venueId','profileId'])if(input[key]!=null&&!['string','number'].includes(typeof input[key]))throw Error('SOURCE_INVALID');
  const instrument=JSON.parse(JSON.stringify(input));if(JSON.stringify(instrument).length>8192)throw Error('SOURCE_INVALID');
  return {type:value.type,id:String(value.id),revision:value.revision??null,instrument,symbol:typeof instrument.symbol==='string'?instrument.symbol:'',recordedAt:value.recordedAt??null,reason:typeof value.reason==='string'?value.reason:'',...(value.recommendationId?{recommendationId:value.recommendationId}:{})};
 }
 function sourceEditorKey(id,source){
  const instrument=source?.instrument||{};
  return id+':source:'+JSON.stringify([source?.type,source?.id,source?.revision??null,...['id','symbol','market','chainId','ca','address','venueId','profileId'].map(key=>instrument[key]??null),...(source?.recommendationId?[source.recommendationId]:[])]);
 }
 function sourceRoute(id,source){
  const input=source.instrument||{},seed=defaultStrategyRoute(id,{market:input.market,executionRoute:{profileId:input.profileId,venueId:input.venueId,chainId:input.chainId==null?'':String(input.chainId)}},desk.snapshot()?.connections);
  const fields=['market','profileId','venueId',...(seed.profileId.startsWith('dex')?['chainId']:[])];
  return fields.some(key=>input[key]!=null&&input[key]!==''&&String(input[key])!==seed[key])?null:seed;
 }
 function sourceInstrumentIssue(source=opened?.source){
  const input=source?.instrument;if(!input)return null;
  const fields=['market','profileId','venueId',...(String(input.profileId||'').startsWith('dex')?['chainId']:[])];
  const mismatch=fields.some(key=>input[key]!=null&&input[key]!==''&&executionRoute?.[key]&&String(input[key])!==executionRoute[key]);
  const assetMismatch=!input.market&&input.symbol&&executionRoute?.market&&String(input.symbol)!==executionRoute.market.split('/')[0];
  return mismatch||assetMismatch?L('当前交易对象与来源不一致。请恢复来源的资产、市场、场所与网络，或返回选择另一份方案。','The trading instrument differs from the source. Restore its asset, market, venue and network, or return to choose another plan.'):null;
 }
 function sourceNotice(source){
  if(!source)return '';
  const instrument=source.instrument||{},asset=instrument.market||instrument.symbol||source.symbol||source.market||L('未提供','Not provided'),chain=instrument.chainId,ca=instrument.ca||instrument.address;
  const identity=String(asset)+(chain?' · '+L('网络','Network')+' '+chain:'')+(ca?' · CA '+ca:'');
  const profile=STRATEGY_MARKETS.find(item=>item.id===instrument.profileId),venue=instrument.venueId;
  const needsScope=!profile||!venue||profile.id.startsWith('dex')&&!chain;
  const scope=profile?L(profile.zh,profile.en)+' · '+(venue||L('场所待确认','Confirm venue'))+(profile.id.startsWith('dex')&&!chain?' · '+L('网络待确认','Confirm network'):''):L('来源未标明交易市场，请确认市场与接入。','The source does not specify a trading market. Confirm the market and connection.');
  const time=source.recordedAt?(typeof source.recordedAt==='number'?formatDataTime(source.recordedAt):String(source.recordedAt)):'',issue=sourceInstrumentIssue(source);
  return '<aside class="sw-source-note" data-source-id="'+e(source.id||'')+'" data-source-revision="'+e(source.revision??'')+'"><details'+(needsScope?' open':'')+'><summary>'+L('来源','Source')+' · '+e(identity)+uiGlyph('chevron')+'</summary><p>'+e(scope)+'</p>'+(time?'<time>'+e(time)+'</time>':'')+(source.reason?'<p>'+e(source.reason)+'</p>':'')+'</details>'+(issue?'<p role="status">'+e(issue)+'</p>':'')+'</aside>';
 }
 function openTemplate(id,onReturn=null,source=null,options={}){
  if(!strategyById(id))return false;
  if(options.defaultProtection&&!protectionValid(options.defaultProtection)){notify(L('风控配置不可用，请重新设置。','Risk configuration is unavailable. Set it again.'),{tone:'error'});return false;}
  let hint=null;
  if(source){try{hint=sourceSnapshot(source);}catch{notify(L('来源信息不完整，请返回来源重新打开。','Source details are incomplete. Return to the source and reopen.'),{tone:'error'});return false;}}
  const fresh=options.fresh===true&&!hint;
  return open(id,null,false,{source:hint,fresh,variant:options.variant,editorKey:hint?sourceEditorKey(id,hint):fresh?id+':new:'+crypto.randomUUID():undefined,onReturn,defaultProtection:options.defaultProtection?structuredClone(options.defaultProtection):null})!==false;
 }
 function recommendationIssue(source=opened?.source){
  const instrumentIssue=sourceInstrumentIssue(source);if(instrumentIssue)return instrumentIssue;
  if(!source?.recommendationId)return null;
  const row=strategyRecommendations(w,desk.snapshot()).find(row=>row.id===source.recommendationId);
  if(!row)return L('这条建议已更新，编辑已保留。请返回查看最新建议。','This recommendation changed. Your edits are retained. Review the latest recommendation.');
  if(nativeEditor()&&(!row.executable||row.strategy!==opened.id||row.variant!==opened.variant))return L('这条研究建议尚未提供该执行版本的依据，不能据此启动机器人。编辑已保留。','This research recommendation does not support this execution version. Your edits are retained; it cannot start a bot.');
  const expected=sourceSnapshot(row.source);
  if(sourceEditorKey(row.strategy,source)!==sourceEditorKey(row.strategy,expected)||['recordedAt','reason'].some(key=>source[key]!==expected[key]))return L('建议来源需要重新核对，编辑已保留。','Review the recommendation source. Your edits are retained.');
  return row.canAdopt?null:L(...row.unavailableReason);
 }
 function clearRecommendationNotice(){
  if(typeof recommendationNotice==='function')recommendationNotice();
  recommendationNotice=null;
 }
 function chooseRecommendation(id,onReturn=null,options={}){
  const row=strategyRecommendations(w,desk.snapshot()).find(row=>row.id===id);
  if(options.intent==='source'){
   if(row&&onRecommendationSource?.(structuredClone(row.sourceRef),onReturn)===true){clearRecommendationNotice();return true;}
   recommendationNotice=notify(L('这条来源暂不可用，请查看原始研究。','This source is unavailable. Review the original research.'),{tone:'error'});return false;
  }
  if(!row?.canAdopt&&!unpinnedCexSpotSetup(row)){recommendationNotice=notify(row?L(...row.unavailableReason):L('这条建议已更新，请查看最新建议。','This recommendation changed. Review the latest suggestion.'),{tone:'error'});return false;}
  if(typeof row.variant!=='string'||strategyPlan(row.strategy,row.variant).variant!==row.variant){recommendationNotice=notify(L('建议未提供可核对的策略版本，请查看原始依据。','The recommendation has no verifiable strategy version. Review its source.'),{tone:'error'});return false;}
  const source=sourceSnapshot(row.source),key=sourceEditorKey(row.strategy,source),existing=loadBotEditors(w)[key];
  if(open(row.strategy,null,true,{source,variant:row.variant,editorKey:key,onReturn})===false)return false;
  if(!existing){
   if(!nativeEditor())mode='signal';amount='';cap='';loadBotParameters();invalidateCheck();remember();renderDrawer();opened.exitBaseline=editFingerprint();
  }
  clearRecommendationNotice();
  return true;
 }

 function memoryScope(){return opened?[opened.id,executionRoute?.profileId||'',executionRoute?.market||''].join('|'):'';}
 function currentMarketType(){
  const profile=executionRoute?.profileId||'';
  if(['cex-spot','cex-perp','dex-spot','dex-perp','dex-lp'].includes(profile))return profile;
  const symbol=String(executionRoute?.market||'').split('/')[0];
  return ['SPX','NDX','XAU','DXY','US10Y'].includes(symbol)||executionRoute?.market&&!String(executionRoute.market).includes('/')?'tradfi':'';
 }
 function loadStrategyMemory(){
  const scope=memoryScope();if(!scope)return;
  const token=++memoryToken,market=currentMarketType();
  memoryView={scope,state:'loading',rules:[],lessons:[],choices:[]};
  const q=new URLSearchParams({strategy:opened.id});if(market)q.set('market',market);
  fetch('/api/memory/context?'+q).then(response=>response.ok?response.json():{rules:[],lessons:[],choices:[]}).then(data=>{
   if(token!==memoryToken||memoryScope()!==scope)return;
   memoryView={scope,state:'ready',rules:data.rules||[],lessons:data.lessons||[],choices:data.choices||[]};
   if(drawer.open){capture();renderDrawer();}
  }).catch(()=>{if(token===memoryToken)memoryView={scope,state:'ready',rules:[],lessons:[],choices:[]};});
 }
 function memoryLines(pages){return pages.length?pages.map(page=>`<p>${page.status==='contested'?L('两面都保留','Both claims stay')+' · ':''}${e(page.body||page.title||'')}</p>`).join(''):`<p>${L('还没有写入','Nothing saved yet')}</p>`;}
 function memoryPanel(){
  if(!opened||!memoryView||memoryView.scope!==memoryScope()||!['configure','overview'].includes(phase))return '';
  const plan=strategyPlan(opened.id,opened.variant),market=currentMarketType();
  const codeEntry=L(...plan.entry),codeExit=L(...plan.exit);
  const oldRule=(memoryView.rules||[]).some(page=>page.codeRule||page.status==='contested');
  const lessons=(memoryView.lessons||[]).filter(page=>!market||!page.marketType||page.marketType===market);
  const choices=(memoryView.choices||[]).filter(page=>{
   const type=(page.body.match(/^市场类型: (.+)$/m)||[])[1]||page.marketType;
   return !market||!type||type===market;
  });
  return `<section class="sc-memory"><h3>${L('策略规则','Strategy rules')}</h3><p>${e(codeEntry)}</p><p>${e(codeExit)}</p>${oldRule?`<p>${L('记忆是旧决定，以当前代码规则为准。','Memory is an older decision. The current code rule is used.')}</p>`:''}${memoryLines(memoryView.rules||[])}<h3>${L('已汇总的参数教训','Collected parameter lessons')}</h3>${memoryLines(lessons)}<h3>${L('你在这个投资入口上上次的选择','Your last choice on this outlet')}</h3>${memoryLines(choices)}</section>`;
 }
 async function writePlanMemory(intent,draft,context){
  const marketType=currentMarketType(),venue=intent.executionRoute?.venueId,instrument=intent.market;
  if(!marketType||!venue||!instrument)return true;
  const parameters=Object.keys(intent.botParameters||{}).filter(name=>/^[a-z0-9_]{1,40}$/.test(name));
  try{
   const response=await fetch('/api/memory/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({strategyId:context.id,version:String(draft.version),marketType,venue,instrument,amount:intent.amount,cap:intent.cap,parameters,planId:String(context.editorKey||draft.id),changed:`金额 ${intent.amount}；上限 ${intent.cap}；参数 ${parameters.join(', ')}`,why:`保存在 ${marketType} ${venue} ${instrument}`,rejected:'没有发送交易所订单'})});
   return response.status===202||response.status===204;
  }catch{return false;}
 }
 function open(id,draftId=null,resumeConfig=false,options={}){
  if(!strategyById(id)||draftId&&!w.draft(draftId))return;
  if(options.variant!=null&&(typeof options.variant!=='string'||strategyPlan(id,options.variant).variant!==options.variant)){notify(L('这套策略不支持该版本，请返回核对建议。','This version is not supported by the strategy. Review the recommendation.'),{tone:'error'});return false;}
  const suggestedRoute=options.source?sourceRoute(id,options.source):null;
  if(options.source&&!suggestedRoute){
   const notice=notify(L('这套 Agent 尚未适配来源的交易市场、场所或网络，请返回核对原始依据。','This Agent does not support the source market, venue or network. Return to review the original evidence.'),{tone:'error'});
   if(options.source.recommendationId)recommendationNotice=notice;
   return false;
  }
  if(editExitDialog?.open)editExitDialog.close();
  if(drawer.open&&opened){capture();remember();}
  settingsReturn=null;returnToCaller=null;opener=document.activeElement;
  const buffers=loadBotEditors(w),draftKey=id+':draft:'+draftId,key=options.editorKey||(draftId&&buffers[draftKey]?draftKey:id);
  if(openPage){openingPage=true;try{openPage(id,key);}finally{openingPage=false;}}
  placeEditor(workspaceHost(root));returnToCaller=typeof options.onReturn==='function'?options.onReturn:null;
  let d=options.fresh?null:draftId?w.draft(draftId):null;
  const pending=options.fresh?null:buffers[key];
  if(!d&&pending?.draftId){const buffered=w.draft(pending.draftId);if(buffered?.strategy===id)d=buffered;}
  let editor=options.fresh?null:readBotEditor(w,id,d,key);
  if(options.source&&editor&&sourceEditorKey(id,editor.source)!==sourceEditorKey(id,options.source))editor=null;
  if(!draftId&&!editor)d=null;
  const choose=Boolean(!openPage&&!draftId&&!resumeConfig&&!options.fresh&&editor&&!visitedEditors.has(key));
  pendingEditor=choose?{id,draftId:d?.id||null,key,sourceHint:options.source||null,editor,defaultProtection:options.defaultProtection||null}:null;
  if(choose){d=null;editor=null;}
  opened={id,draftId:d?.id||null,restored:Boolean(d||editor),variant:editor?.variant||d?.planVariant||options.variant||(d?'baseline':defaultBotVariant(id)),source:options.source||editor?.source||d?.researchSource,editorKey:key,previousEditorKey:options.previousEditorKey||editor?.previousEditorKey||null,defaultProtection:options.defaultProtection||null,editorScope:editorScope(),exitBuffer:structuredClone(buffers[key]||null)};
  opened.exitAlias=snapshotEditorAlias(opened,buffers);
  workspaceSource=options.source||null;
  executionRoute=attachConnectedBinanceSpot(editor?.executionRoute||(d?defaultStrategyRoute(id,d,desk.snapshot()?.connections):suggestedRoute||defaultStrategyRoute(id,null,desk.snapshot()?.connections)),desk.snapshot()?.connections);
  const defaultedMarket=(openPage||inlineHost)&&!choose&&!d&&!editor?.localSaved&&!opened.source&&!executionRoute.market?routeAssets(executionRoute).find(market=>!nativeEditor()||Object.hasOwn(BOT_MARKETS,market))||'':'';
  if(defaultedMarket)executionRoute.market=defaultedMarket;
  botParameterSets=editor?.botParameterSets&&typeof editor.botParameterSets==='object'&&!Array.isArray(editor.botParameterSets)?editor.botParameterSets:{};loadBotParameters();if(editor?.botParameters)botParameters={...editor.botParameters};else if(d?.botParameters)botParameters={...d.botParameters};parameterSource=editor?.parameterSource||'recommended';parameterReference=editor?.parameterReference||parameterReference;simulationReference=editor?editor.simulationReference||null:d?.simulationReference||null;
  if(simulationReference&&['market','profileId','venueId'].some(key=>simulationReference[key]!==executionRoute[key]))simulationReference=null;
  configView='quick';mobileView=editor?.mobileView==='market'?'market':'settings';viewScroll={settings:Math.max(0,Number(editor?.viewScroll?.settings)||0),market:Math.max(0,Number(editor?.viewScroll?.market)||0)};gridPreviews=editor?.gridPreviews&&typeof editor.gridPreviews==='object'&&!Array.isArray(editor.gridPreviews)?editor.gridPreviews:{};planTab='plan';planScenario='A';
   const emptyTemplate=!d&&!editor;
   amount=editor?.amount??d?.amount??(emptyTemplate?'':100);cap=editor?.cap??d?.cap??(emptyTemplate?'':Math.min(500,w.s.risk.cap));
  mode=editor?.mode||d?.mode||(options.source&&!nativeEditor()?'signal':'auto');protection=editor?.protection||d?.protection||(!d&&!editor&&!choose&&nativeEditor()&&options.defaultProtection?structuredClone(options.defaultProtection):protectionConfig(d?'original':'astarter'));riskScene='normal';researchBudget=editor?.researchBudget??strategySetupCosts(w).daily;
  phase=d||editor?'configure':'overview';if(d?.status==='validating')phase='check';
  if(d?.botLaunch){if(['requested','unknown','accepted','started'].includes(d.botLaunch.status)&&reconcileStrategyWatch(w,desk,d))phase='unknown';else if(['stopped','interrupted','failed'].includes(d.botLaunch.status)&&!resumeConfig)phase='ended';}
  if(!strategyPlan(id,opened.variant).flowAvailable&&!d?.executionRoute&&!resumeConfig)phase='overview';
   if(choose)phase='resume';else{visitedEditors.add(key);if((openPage||inlineHost||options.source||nativeEditor())&&phase==='overview')phase='configure';}
  if(inlineHost)workspaceSelection=id;
  opened.exitBaseline=editFingerprint();
  feedback='';renderDrawer();loadStrategyMemory();if(!drawer.open){if(inlineHost)drawer.show();else drawer.showModal();disposeBotCharts=mountBotCharts();}const body=editorScrollElement();if(body)body.scrollTop=viewScroll[mobileView]||0;if(options.fresh&&openPage||defaultedMarket)remember();
 }
 const facts=rows=>`<dl class="sc-facts">${rows.map(([label,value])=>`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
 function rules(s){const p=strategyPlan(s.id,opened?.id===s.id?opened.variant:'baseline');return `<details class="sc-rules"><summary>${L('策略规则与版本','Rules & version')}</summary><div>${facts([[L('版本','Version'),e(p.baseVersion)],[L('开仓','Entry'),e(L(...p.entry))],[L('退出','Exit'),e(L(...p.exit))],[L('原规则计划风险 / 名义上限','Original planned risk / notional ceiling'),`${parameterValue(p.record.parameters.risk_fraction)} / ${parameterValue(p.record.parameters.notional_fraction)}`]])}</div></details>`;}
 function header(mine){return `<header class="sc-heading"><h1>${L(mine?'我的交易':'策略广场',mine?'My trading':'Strategies')}</h1><div class="sc-heading-end">${mine?scBtn(L('添加 Agent','Add Agent'),'navigate','strategies',true):''}${scBtn(L('贡献策略','Contribute'),'navigate','contributions')}</div></header>`;}

 const marketplaceTypeIcon=id=>id.includes('grid')?'range':id.includes('twap')||id==='perp-vp'?'copy':id==='funding-hedge'?'chain':id==='rebalance'?'shield':'trend';

 const workspaceName=id=>strategyName(strategyById(id));
 const workspaceChoice=()=>workspaceSelection;
 function workspaceItems(){
  const suggestions=strategySuggestions(w).filter(item=>item.phase==='complete');
  const choices=catalogView==='recommendations'?suggestions.map(suggestion=>({s:strategyById(suggestion.strategy),suggestion})).filter(item=>item.s):CATALOG.map(s=>({s}));
  const families=choices.filter(({s,suggestion})=>{
   const kind=scText(s)[4],scope=strategyScope(s.id),product=BOT_PRODUCT_CAPABILITIES.find(item=>item.family===s.id);
   return (catalogView!=='capabilities'||product)&&(!compareOnly||product&&(w.s.botCatalogSelections||[]).includes(product.id))&&(group==='all'||kind===group)&&(marketScope==='all'||(marketScope==='chain'?kind==='chain':marketScope==='derivatives'?s.id==='RX05':kind!=='chain'&&s.id!=='RX05'))&&(!onlyReady||strategyPlan(s.id).flowAvailable)&&(marketTime==='all'||(marketTime==='short'?/5m|15m|30m|盘口|逐笔|book|tick/i:/1h|4h|1d/i).test(strategyTimeframe(s)))&&([workspaceName(s.id),s.id,...scText(s),...scope.label,...(product?.name||[]),suggestion?.symbol||'',suggestion?.reason||''].join(' ').toLowerCase().includes(query.toLowerCase()));
  }).map(({s,suggestion})=>({id:suggestion?'research:'+suggestion.symbol:s.id,family:s,source:suggestion,group:'official',title:(suggestion?suggestion.symbol+' · ':'')+workspaceName(s.id),subtitle:suggestion?suggestion.reason:s.id+' · '+L(...strategyScope(s.id).label),icon:strategyScope(s.id).icon,risk:Number(strategyPlan(s.id).record.parameters.risk_fraction?.value??Infinity)}));
  const candidates=catalogView==='recommendations'||onlyReady||marketTime!=='all'?[]:BOT_PRODUCT_CAPABILITIES.filter(item=>{
   const kind=item.id.includes('grid')||item.id.includes('dca')?'range':item.id==='pyramiding'?'trend':'all';
   return !item.family&&(!compareOnly||(w.s.botCatalogSelections||[]).includes(item.id))&&(group==='all'||kind===group)&&(marketScope==='all'||(marketScope==='derivatives'?item.id.startsWith('perp-')||item.id==='funding-hedge':marketScope==='spot'?item.id.startsWith('spot-')||item.id==='rebalance':false))&&([...item.name,...item.scope,item.id].join(' ').toLowerCase().includes(query.toLowerCase()));
  }).map(item=>({id:'product:'+item.id,product:item,group:'candidate',title:L(...item.name),subtitle:L(...item.scope),icon:marketplaceTypeIcon(item.id),risk:Infinity}));
  return [...families,...candidates].sort((a,b)=>marketSort==='risk'?a.risk-b.risk:marketSort==='id'?a.id.localeCompare(b.id):a.id==='S03'?-1:b.id==='S03'?1:0);
 }
 function workspaceDirectory(items){
  const selected=workspaceChoice(),tabstop=items.some(item=>item.id===selected)?selected:items[0]?.id;
  return [['range','区间与分批','Range & scaling'],['trend','趋势与结构','Trend & structure'],['chain','链上与资金流','On-chain & flows'],['event','事件与风控','Events & protection']].map(([kind,zh,en])=>{
   const rows=items.filter(item=>scText(item.family)[4]===kind);if(!rows.length)return '';
   return `<section class="sw-directory-group"><h3>${L(zh,en)}</h3>${rows.map(item=>`<button type="button" class="sw-strategy" data-sc="workspace-select" data-id="${e(item.id)}" data-strategy="${e(item.family.id)}" role="radio" aria-checked="${selected===item.id}" tabindex="${tabstop===item.id?'0':'-1'}" aria-controls="strategy-workspace-editor"><span class="sw-strategy-icon">${scIcon(FAMILY_ICONS[item.family.id]||item.icon)}</span><span class="sw-strategy-copy"><b>${e(item.title)}</b></span>${selected===item.id?'<span class="sw-selected-check" aria-hidden="true">'+uiGlyph('check')+'</span>':''}</button>`).join('')}</section>`;
  }).join('');
 }
 function catalog(){
  const requested=new URLSearchParams(globalThis.location?.search||'').get('create');if(strategyById(requested))workspaceSelection=requested;
  const items=CATALOG.map(family=>({id:family.id,family,title:workspaceName(family.id),icon:strategyScope(family.id).icon})),selected=workspaceChoice(),selectedTitle=items.find(item=>item.id===selected)?.title||L('创建 Agent','Create Agent');
  return `<div class="bh-root sw-creation-page" data-bot-page="create" data-localized-ui><div class="sc-root sw-workspace"><aside class="sw-sidebar"><header><button type="button" class="sw-back" data-sc="navigate" data-id="strategies">${uiGlyph('arrow')}${L('策略总览','Strategy overview')}</button></header><label class="sw-mobile-choice"><span>${L('选择策略','Choose strategy')}</span><select id="sw-strategy-choice" aria-label="${L('选择策略','Choose strategy')}">${items.map(item=>`<option value="${e(item.id)}" ${item.id===selected?'selected':''}>${e(item.title)}</option>`).join('')}</select></label><div class="sw-strategy-list" role="radiogroup" aria-orientation="vertical" aria-label="${L('策略列表','Strategies')}">${workspaceDirectory(items)}</div></aside><div class="sw-editor-host" id="strategy-workspace-editor" data-strategy-workspace-host aria-label="${e(selectedTitle)}"></div></div></div>`;
 }
 function nativeTrading(){
  const status=desk.syncStatus(),data=desk.readSnapshot();
  const head=header(true)+scopeHeader(status);
  if(!data||status.scope?.accountId!=='SIM-01'||status.scope?.environment!=='DEMO')return head;
  const error=data.botSummary?.recoveryError;if(error)return '<div class="sc-root" data-localized-ui>'+head+'<p class="sc-feedback" role="alert">'+e(error)+'</p></div>';
  const body=mineFilter==='history'?botHistoryView(data,nativeNames()):mineFilter==='saved'?mine(true):botInstancesView(data,nativeNames(),{endRunId})+(mineFilter==='all'?mine(true):'');
  return `<div class="sc-root bot-trading-workspace" data-localized-ui>${head}${error?'<p class="sc-feedback" role="alert">'+e(error)+'</p>':''}${botManagementSummary(w,data)}${mineToolbar()}${body||'<div class="sc-empty">'+L('这里还没有策略。先从策略广场选一个。','No strategies here yet. Choose one in the marketplace.')+'</div>'}</div>`;
 }
 function mineToolbar(){return `<div class="sc-toolbar"><div class="sc-filter-tabs">${[['all','全部','All'],['active','运行与等待','Active & watching'],['saved','已保存','Saved'],['history','执行记录','Run history']].map(([id,z,en])=>`<button data-sc="mine-filter" data-id="${id}" aria-pressed="${mineFilter===id}">${L(z,en)}</button>`).join('')}</div><button class="sc-link" data-sc="navigate" data-id="billing">${L('积分明细','Credit history')} ↗</button></div>`;}
 function localDraftCard([key,editor]){
  const native=isBotSimulation({strategy:editor.id,planVariant:editor.variant});
  return `<article class="sc-my-card" data-local-editor="${e(key)}"><div class="sc-my-identity"><span class="sc-card-icon">${scIcon(scText(strategyById(editor.id))[4])}</span><div><h3>${strategyName(strategyById(editor.id))}</h3><small>${e(editor.executionRoute?.market||L('待选择资产','Choose an instrument'))}</small></div><span class="sc-tag">${L('待完成配置','Setup incomplete')}</span></div><footer><p>${L(native?'配置已保留，确认账户、金额与资金保护后再检查。':'研究配置已保留，可继续核对市场、依据与资金边界。',native?'Your configuration is saved. Confirm account, allocation and protection before checking.':'Your research configuration is saved. Review the market, evidence and allocation limits.')}</p><div>${scBtn(L('继续配置','Continue setup'),'edit-local',key,true)}</div></footer></article>`;
 }
 const localDraftInScope=editor=>editor?.localSaved?.scope===(w.account?.scope||'local')&&editor.localSaved.environment===(w.s.setupContext?.environment||'DEMO');
 function mine(embedded=false){const s=desk.snapshot();if(!embedded&&mineFilter==='history')return `<div class="sc-root" data-localized-ui>${header(true)}${botManagementSummary(w,s)}${mineToolbar()}${botHistoryView(s,Object.fromEntries(CATALOG.map(item=>[item.id,strategyName(item)])))}</div>`;const rows=w.s.drafts.filter(d=>embedded?activeId()!==d.id&&!activeNative(d):mineFilter==='all'||mineFilter==='active'&&activeId()===d.id||mineFilter==='saved'&&activeId()!==d.id);const local=embedded?Object.entries(loadBotEditors(w)).filter(([,editor])=>localDraftInScope(editor)&&!editor.draftId&&strategyById(editor.id)):[];if(embedded&&!rows.length&&!local.length)return '';return `<div class="sc-root ${embedded?'trading-saved-plans':''}" data-localized-ui>${embedded?`<header class="section-heading"><h2>${L('已保存方案','Saved plans')}</h2><span>${rows.length+local.length}</span></header>`:header(true)+botManagementSummary(w,s)+mineToolbar()}<div class="sc-my-list">${local.map(localDraftCard).join('')}${rows.map(d=>{const st=status(d),active=activeId()===d.id,plan=strategyPlan(d.strategy,d.planVariant),researchOnly=st[2]==='research',v=w.s.validations.find(v=>v.id===d.validationId);return `<article class="sc-my-card" data-draft="${e(d.id)}"><div class="sc-my-identity"><span class="sc-card-icon">${scIcon(scText(strategyById(d.strategy))[4])}</span><div><h3>${strategyName(strategyById(d.strategy))}${!researchOnly&&d.protection?.id==='astarter'?'<span class="sc-paired-label"> + Astarter</span>':''}</h3><small>${d.strategy} · v${d.version}</small>${d.executionRoute?`<small class="bot-saved-route">${e(routeSummary({...d.executionRoute,market:d.market}))}</small>`:''}</div><span class="sc-tag ${st[2]==='live'?'available':st[2]==='paused'?'paused':''}"><i></i>${L(st[0],st[1])}</span></div>${researchOnly?`<div class="sc-research-identity"><span>${L(...strategyScope(d.strategy).label)}</span><b>${plan.candidate?plan.variant:L('原版','Baseline')}</b></div>`:`<div class="sc-combo-amount"><span>${L('最多使用','Allocation limit')}<b>${d.cap} <small>${e(d.market?.split('/')[1]||'USDT')}</small></b></span><span>${L(strategyFlowAvailable(d)?'出现机会后':'执行偏好',strategyFlowAvailable(d)?'On an opportunity':'Execution preference')}<strong>${isBotSimulation(d)?L('批准方案后运行','Run the approved plan'):L(...modes[d.mode])}</strong></span></div>` }${isBotSimulation(d)?botParameterFacts(d):''}${active?botRunStats(d,s):''}<details class="sc-combo-details" data-combo="${e(d.id)}" data-persist-key="strategy-combo-${e(d.id)}" ${expandedDrafts.has(d.id)?'open':''}><summary>${researchOnly?`<span class="sc-combo-trade">${uiGlyph('file')}<b>${L('研究规则与版本','Research rules & version')}</b></span><span class="sc-combo-chevron" aria-hidden="true">${uiGlyph('chevron')}</span>`:`<span class="sc-combo-trade">${scIcon(scText(strategyById(d.strategy))[4])}<span><small>${L('交易策略','Trading strategy')}</small><b>${strategyName(strategyById(d.strategy))}</b></span></span><span class="sc-combo-protection">${scIcon('shield')}<span><small>${L('同时保护资金','Capital protection alongside')}</small><b>${d.protection?.id==='astarter'?'Astarter · '+L(d.protection.mode==='conservative'?'保守':'正常',d.protection.mode==='conservative'?'Conservative':'Normal'):L('策略原有保护','Original strategy protection')}</b></span><span class="sc-combo-chevron" aria-hidden="true">${uiGlyph('chevron')}</span></span>`}</summary><div class="sc-combo-content">${researchOnly?facts([[L('已保存版本','Saved version'),plan.candidate?plan.variant:L('原版','Baseline')],[L('适用范围','Scope'),L(...strategyScope(d.strategy).label)],[L('执行状态','Execution status'),L('等待执行验证','Awaiting execution validation')]]):facts([[L('策略总金额','Allocation'),`${d.cap} USDT`],[L('每次买入','Per entry'),`${d.amount} USDT`],[L('出现信号后','On a signal'),isBotSimulation(d)?L('批准方案后运行','Run the approved plan'):L(...modes[d.mode])],[L('资金保护','Protection'),d.protection?.id==='astarter'?'Astarter · '+L(d.protection.mode==='conservative'?'保守':'正常',d.protection.mode==='conservative'?'Conservative':'Normal'):L('策略原有保护','Original strategy rules')],[L('本次检查','Latest check'),v&&(v.version!==d.version||v.riskVersion!==w.s.risk.version)?L('需要重新检查','Check again'):v?L(...({passed:['已通过','Passed'],running:['进行中','In progress'],blocked:['需要调整','Needs changes'],cancelled:['已取消','Cancelled']}[v.status]||['未检查','Not checked'])):L('待检查','Not checked')]])}</div></details><footer>${active?`<p>${L(s.discovery?.armed?'正在寻找下一条合格机会，暂未下单。':'当前交易的信号、订单与持仓可在运行详情查看。',s.discovery?.armed?'Watching for a qualified opportunity. No order yet.':'See signals, orders and holdings in run details.')}</p>`:researchOnly?`<p>${L('已保存研究方案，等待执行验证。','Research plan saved; awaiting execution validation.')}</p>`:''}<div>${s.discovery?.armed&&active?scBtn(L('关闭等待','Stop watching'),'disarm'):''}${active&&!s.discovery?.armed?(['running','paused'].includes(s.state)?scBtn(L(s.state==='running'?'暂停买入':'恢复运行',s.state==='running'?'Pause entries':'Resume'),'trade',s.state==='running'?'pause':'resume'):'')+scBtn(L('停止','Stop'),'stop',d.id):''}${active?scBtn(L('查看运行','View activity'),'navigate','execution',true):scBtn(L(!isBotSimulation(d)?d.executionRoute?'编辑设置':'查看方案':d.status==='validating'?'查看检查':'设置并启动',!isBotSimulation(d)?d.executionRoute?'Edit settings':'View plan':d.status==='validating'?'View check':'Set up & start'),'draft',d.id,true)}</div></footer></article>`;}).join('')||`<div class="sc-empty">${L('这里还没有策略。先从策略广场选一个。','No strategies here yet. Choose one in the marketplace.')}${scBtn(L('浏览 Agent','Explore Agents'),'navigate','strategies',true)}</div>`}</div>${!embedded&&w.s.astarterDrafts?.length?`<div class="sc-mine-banner"><div><b>${L('资金保护组合','Protection combinations')} · ${w.s.astarterDrafts.length}</b><p>${L('已保存，尚未应用到交易。','Saved, not yet applied to trading.')}</p>${scBtn(L('查看组合','View combinations'),'navigate','risk')}</div>`:''}</div>`;}
 function protectionOptions(s){
  if(nativeEditor()){
   const selected=protection.id==='astarter';
   return `<details class="sc-protection-settings" data-persist-key="strategy-protection"><summary><span>${scIcon('shield')}${L('资金保护','Capital protection')}</span><b>${selected?'Astarter · '+L(protection.mode==='conservative'?'保守':'正常',protection.mode==='conservative'?'Conservative':'Normal'):L('策略原有保护','Original strategy protection')}${uiGlyph('chevron')}</b></summary><div><div class="sc-protection-choices">${[['astarter','Astarter 资金保护','Astarter capital protection'],['original','沿用策略原有保护','Keep original strategy protection']].map(([id,zh,en])=>`<button type="button" class="sc-policy ${protection.id===id?'selected':''}" data-sc="policy" data-id="${id}" aria-pressed="${protection.id===id}"><span class="sc-policy-icon">${scIcon(id==='astarter'?'shield':FAMILY_ICONS[s.id])}</span><span><b>${L(zh,en)}</b><small>${L(id==='astarter'?'按本 BOT 额度核算风险与回撤':'使用本方案的止盈止损参数',id==='astarter'?'Size risk and drawdown within this BOT allocation':'Use this plan’s take-profit and stop-loss settings')}</small></span></button>`).join('')}</div>${selected?`<div class="sc-risk-setting"><b>${L('起步方式','Starting mode')}</b><div>${[['normal','正常','Normal'],['conservative','更保守','Conservative']].map(([id,zh,en])=>`<button type="button" data-sc="risk-mode" data-id="${id}" aria-pressed="${protection.mode===id}">${L(zh,en)}</button>`).join('')}</div><p>${L('按本 BOT 分配额度、止损距离和未完成订单核算；触线后暂停新增买入，已有库存保留。','Uses this BOT allocation, stop distance and open orders. A limit pauses new buys and retains existing inventory.')}</p>${facts(botProtectionRows({protection}))}</div>`:botParameterFacts(nativePlan())}</div></details>`;
  }
  const p=companionPreview(riskScene,protection.mode),selected=protection.id==='astarter';
  return `<details class="sc-protection-settings" data-persist-key="strategy-protection"><summary><span>${scIcon('shield')}${L('资金保护','Capital protection')}</span><b>${selected?'Astarter · '+L(protection.mode==='conservative'?'保守':'正常',protection.mode==='conservative'?'Conservative':'Normal'):L('策略原有保护','Original strategy protection')}${uiGlyph('chevron')}</b></summary><div><div class="sc-protection-choices"><button type="button" class="sc-policy ${selected?'selected':''}" data-sc="policy" data-id="astarter" aria-pressed="${selected}"><span class="sc-policy-icon">${scIcon('shield')}</span><span><b>Astarter ${L('资金保护','capital protection')}</b><small>${L('控制投入 · 回落降档 · 利润留存','Size entries · scale down · retain profit')}</small></span><i>${selected?'✓':'○'}</i></button><button type="button" class="sc-policy ${!selected?'selected':''}" data-sc="policy" data-id="original" aria-pressed="${!selected}"><span class="sc-policy-icon original">${scIcon(scText(s)[4])}</span><span><b>${L('沿用策略原有保护','Keep original strategy protection')}</b><small>${L('保持原策略的金额、止损与退出规则','Keep the original sizing, stop and exit rules')}</small></span><i>${!selected?'✓':'○'}</i></button></div>${selected?`<div class="sc-risk-setting"><b>${L('起步方式','Starting mode')}</b><div>${[['normal','正常','Normal'],['conservative','更保守','Conservative']].map(([id,z,en])=>`<button type="button" data-sc="risk-mode" data-id="${id}" aria-pressed="${protection.mode===id}">${L(z,en)}</button>`).join('')}</div><small>${L(protection.mode==='conservative'?'新交易的风险额度从正常档的一半开始。':'有余地再投入，触发回落条件会自动降档。',protection.mode==='conservative'?'Start new trades at half the normal risk budget.':'Size within your limits; scale down when drawdown requires it.')}</small></div><details class="sc-risk-explainer"><summary>${L('遇到这些情况，会怎么做？','How would it respond?')}</summary><div class="sc-risk-demo"><div class="sc-situation-tabs">${[['normal','正常','Normal'],['crowded','买得太集中','Concentration'],['drawdown','收益回落','Drawdown'],['halt','触发暂停','Hard pause'],['profit','利润结算','Profit settled'],['unknown','订单未知','Unknown order']].map(([id,z,en])=>`<button type="button" data-sc="risk-scene" data-id="${id}" aria-pressed="${riskScene===id}">${L(z,en)}</button>`).join('')}</div><div class="sc-risk-demo-result ${p.amount===0?'paused':''}"><div class="sc-risk-visual"><div class="sc-risk-rail"><i style="width:${Math.min(100,(riskScene==='profit'?p.state.reserve:p.amount)/1000*100)}%"></i></div><span>${riskScene==='profit'?L('利润储备','Profit reserve'):L('本次可投入','Allowed entry')}</span><strong>${(riskScene==='profit'?p.state.reserve:p.amount).toLocaleString('en-US',{maximumFractionDigits:2})}<small>USDT</small></strong></div><p>${L(...({normal:['先算风险，再决定这笔能买多少。','Calculate risk before sizing the entry.'],crowded:['同类资产已占用额度，这笔自动缩小。','Related holdings use the budget, so this entry shrinks.'],drawdown:['从高点回落超过 3%，新交易风险减半。','Over 3% below the high: halve risk for new trades.'],halt:['触及暂停线，不再新增买入。','A hard limit is reached. No new buys.'],profit:['新增已结算利润 2,000，留存 20% 即 400。','New settled profit of 2,000 reserves 20%, or 400.'],unknown:['先查询原订单，确认前不重复买入。','Reconcile the original order before buying again.']}[riskScene]))}</p></div><small>${L('按 10,000 USDT 示例账户、申请 1,000、止损距离 2% 和往返费用 0.2% 演算，不影响当前交易。','Uses a 10,000 USDT fixture, 1,000 entry request, 2% stop distance and 0.2% round-trip costs. Current trades are unaffected.')}</small></div></details><details class="sc-rules"><summary>${L('查看保护规则与来源','Protection rules & source')}</summary>${facts([[L('每次计划风险上限','Episode risk ceiling'),'0.25%'],[L('单次投入上限','Entry notional ceiling'),'10%'],[L('组合 / 单资产 / 相关资产 / 同事件','Portfolio / asset / group / event'),'1% / 0.5% / 0.6% / 0.5%'],[L('日亏损暂停 / 风险期预算','Daily pause / risk-period budget'),'2% / 5%'],[L('高点回落降档 / 暂停','Drawdown scale-down / pause'),'3% / 8%'],[L('已结算新增净利润留存','New settled profit retained'),'20%']])}<p>${L('依据你的 H5 资管研究与 Astarter 整合规则。原策略更低的限制优先；加入保护另存组合，不覆盖原版。凯利自动仓位、盈利加仓和积极扩额均关闭。','Based on your H5 capital research and Astarter policy. Lower original limits still apply. This saves a separate combination. Automatic Kelly sizing, pyramiding and aggressive scaling remain off.')}</p><p>${L('模拟执行按固定止损距离展示金额调整与暂停；不是完整交易引擎。计划风险不保证实际亏损上限，利润储备不等于已提现。','The local demo uses a fixed stop-distance fixture for sizing and pause behavior, not a full trading engine. Planned risk is not a guaranteed loss ceiling; reserves are not withdrawals.')}</p><small>${PROTECTION_VERSION}</small></details>`:`<div class="sc-detail-caution"><b>${L('原有保护仍然生效','Original protection remains')}</b><p>${L('继续使用这套策略原来的买入上限、止损和暂停条件。具体数值可在下方查看。','Keep this strategy’s original entry limits, stops and pause conditions. View the exact rules below.')}</p></div>${rules(s)}`}</div></details>`;
 }
 function parameterValue(p){
  if(!p||p.value===null)return L('待配置','Not configured');const v=p.value,u=p.unit;
  if(typeof v==='boolean')return v?L('开启','On'):L('关闭','Off');
  if(Array.isArray(v))return v.map(x=>u.includes('fraction')?`${Number(x)*100}%`:u==='grid spacing d'?`${x}d`:x).join(' / ');
  if(typeof v==='object')return Object.entries(v).map(([key,value])=>`${({trend:'T',pattern:'P',energy:'E',location:'L',total:'Σ'})[key]||key} ${value}`).join(' · ');
  if(u.includes('fraction')&&Number.isFinite(Number(v)))return `${Number((Number(v)*100).toFixed(4))}%`;
  if(u==='s')return Number(v)>=3600?`${Number(v)/3600}h`:`${v}s`;
  if(u==='ms'||u==='bps')return `${v} ${u}`;
  if(u.startsWith('ATR_'))return `${v} × ATR(${u.slice(4)})`;
  if(u==='price_D')return `${v}R`;
   if(u==='grid spacing d')return `${v}d`;
  if(/boundaries| bars/.test(u))return `${v} × ${u.match(/\d+[mhd]/)?.[0]||L('K线','bars')}`;
  if(u==='min'||u==='h'||u==='days')return `${v} ${u==='days'?L('天','days'):u}`;
  if(u==='chain_id')return v==='eip155:1'?'Ethereum':v;
  return String(v);
 }
 function executionParameters(p){
  const keys=p.variant==='S02-VP'?['virtual_probe_layers','physical_layers','spacing_pct_min','spacing_atr_min','size_weights','physical_offsets_d','stop_offset_d','target_offset_d','max_hold_from_setup','risk_fraction','notional_fraction']:p.keys;
  const extraLabels={physical_offsets_d:['实际层位置','Physical level offsets'],stop_offset_d:['共同止损位置','Basket stop offset'],target_offset_d:['均价上方目标','Target above average'],max_hold_from_setup:['本轮最长期限','Episode maximum'],risk_fraction:['整篮风险上限','Basket risk ceiling'],notional_fraction:['名义投入上限','Notional ceiling']};
  return `<section class="sc-plan-parameters"><div class="sc-plan-section-title"><h3>${L('参数基准','Parameter defaults')}</h3><span>${L('只读','Read only')}</span></div>${p.candidate?`<div class="sc-candidate-change"><b>${e(L(...p.candidate.name))}</b><p>${e(L(...p.candidate.change))}</p></div>`:''}<dl>${keys.filter(key=>p.record.parameters[key]).map(key=>`<div><dt>${L(...(PARAMETER_LABELS[key]||extraLabels[key]||[key,key]))}</dt><dd>${e(parameterValue(p.record.parameters[key]))}</dd></div>`).join('')}</dl><p class="sc-plan-small">${L('新参数另建版本；已有运行继续使用已批准的设置。','Parameter changes require a new version. Active runs retain their approved settings.')}</p></section>`;
 }
 function layerPreview(p){
  if(!['S01','S02'].includes(p.id))return '';
  const vp=p.variant==='S02-VP',grid=p.id==='S01',rows=vp?[['C0',0,true],['C0 − d',0,true],['C0 − 2d',1],['C0 − 3d',1.5],['C0 − 4d',2.25]]:grid?Array.from({length:4},(_,i)=>[`C0 − ${i+1}d`,1]):[['p0',1],['p0 − ATR',1.5],['p0 − 2ATR',2.25]];
  return `<section class="sc-layer-preview"><h3>${L('分层计划','Layer plan')}${scInfo(L('参考层价与数量','Levels and sizing'),L('C0为冻结参考价。网格及VP的d取0.4%参考价与0.5倍1h ATR的较大值；原三层S02使用5m ATR。表内权重是基础币数量比例，实际成交前不产生库存。','C0 is the frozen reference. Grid and VP spacing d is the greater of 0.4% of C0 and 0.5 × 1h ATR; original S02 uses 5m ATR. Weights are base-quantity ratios. Only actual fills create inventory.'))}</h3><div class="sc-layer-table"><table><thead><tr><th>${L('参考层价','Reference level')}</th><th>${L('数量权重','Size weight')}</th><th>${L('实际成交 / 可卖','Filled / sellable')}</th></tr></thead><tbody>${rows.map(([level,weight,virtual])=>`<tr class="${virtual?'virtual':''}"><td>${level}${virtual?`<small>${L('虚拟','Virtual')}</small>`:''}</td><td>${weight||'—'}</td><td>${virtual?L('不入账','Excluded'):'—'}</td></tr>`).join('')}</tbody></table></div><p class="sc-plan-small">${L('层价待行情与账户核算；只按真实成交管理库存，虚拟试探不计资金或盈亏。','Levels require market and account calculation. Only actual fills create inventory; virtual probes do not enter funds or P&L.')}</p></section>`;
 }
 function executionABC(p){
  const specialized={
   'S09-A':{A:L('同一链状态下重报价并通过模拟，扣除Gas和费用后仍达标，才提交原子闭环交易。','Requote against one chain state and simulate the atomic route. Submit only when net profit still clears gas and fees.'),C:L('未知nonce先核对链上状态，不换nonce重复提交；失败按实际receipt记录Gas，不记虚构套利利润。','Reconcile unknown nonces before resubmitting. Record failed-route gas from actual receipts, without inventing arbitrage profit.')},
   'S09-L':{A:L('核对已登记池与仓位，再按批准区间配置流动性；费用、本金与两种资产库存一起计价。','Verify the registered pool and position, then allocate within the approved range. Value fees, principal and both asset balances together.'),C:L('先核对nonce和仓位归属；撤流后仍有两种资产，按实际到账库存处理，不能把撤流当作全额变现。','Reconcile the nonce and position ownership. Withdrawal leaves two assets; manage actual received balances rather than treating withdrawal as full cash liquidation.')},
   RX04:{A:L('只减少已批准基础策略的现有库存；压力档位限制库存至50%或零，不建立独立买入仓位。','Reduce existing inventory of the approved base strategy only. Pressure tiers cap inventory at 50% or zero, without opening a separate buy position.'),C:L('由唯一退出协调器处理，基础策略止损优先；未知订单先核对，不重复卖出，也不自动买回。','Use the single exit coordinator with base-strategy stops taking priority. Reconcile unknown orders before selling again; never buy back automatically.')}
  }[p.id];
  const scenarios={A:[L('按计划运行','Run as planned'),p.id==='S01'?L('按冻结的四层计划挂单，只卖出已成交库存；补单重新核对整篮风险。','Place the frozen four levels and sell filled inventory only. Recheck basket risk before replenishing.'):p.id==='S02'?L('按已批准的层价、权重与共同止损执行，实际最多三层；不扩大亏损后起仓量。','Use approved levels, weights and a shared stop, with at most three physical layers. Do not raise the next basket size after a loss.'):L('入场条件与账户额度同时通过才执行；已有仓位按固定退出计划管理。','Enter only when both strategy and account checks pass. Manage held inventory under its fixed exit plan.')],B:[L('条件变化时','When conditions change'),p.id==='S03'?L('RSI低于45连续两根5m或达到36根持有边界时退出，不临时补设固定止盈。','Exit after two 5m RSI closes below 45 or the 36-boundary holding limit. Do not add an ad-hoc fixed take-profit.'):L(...p.exit)],C:[L('触发保护时','When protection triggers'),L('硬保护优先。报价过期不新增风险；订单未知保留占用并查询；部分成交只保护剩余真实库存。','Hard protection takes priority. Stale quotes block new risk; unknown orders retain reservations and require reconciliation; partial exits protect the remaining actual inventory.')]};
  if(specialized){scenarios.A[1]=specialized.A;scenarios.C[1]=specialized.C;}
   const active=scenarios[planScenario]||scenarios.A;
  const risk=p.record.parameters.risk_fraction?.value||'0.0025',notional=p.record.parameters.notional_fraction?.value||'0.10';
  return `<section class="sc-plan-abc"><div class="sc-plan-section-title"><h3>${L('运行与保护','Run & protection')}</h3><span>${L('止损和故障优先','Stops and faults first')}</span></div>${p.candidate?`<div class="sc-candidate-change"><b>${e(L(...p.candidate.name))}</b><p>${e(L(...p.candidate.change))}</p></div>`:''}<div class="sc-plan-scenarios" role="group" aria-label="${L('情景预案','Scenario plans')}">${Object.entries(scenarios).map(([id,[label]])=>`<button type="button" data-sc="scenario" data-id="${id}" aria-pressed="${planScenario===id}">${label}</button>`).join('')}</div><div class="sc-scenario-result"><h4>${active[0]}</h4><p>${active[1]}</p></div>${!['S09-A','S09-L','RX04'].includes(p.id)?facts([[L('原规则计划风险上限','Original planned-risk ceiling'),`${Number(risk)*100}%`],[L('原规则名义投入上限','Original notional ceiling'),`${Number(notional)*100}%`]]):''}<p class="sc-plan-small">${L('金额以账户剩余额度与实际止损距离核算；跳空可能超过计划损失。','Size depends on remaining account limits and the actual stop distance. Gaps can exceed planned loss.')}</p>${layerPreview(p)}</section>`;
 }
 function executionOverview(s,p){
  const scope=strategyScope(s.id),draft=opened.draftId?w.draft(opened.draftId):null,instrument=executionRoute?.market||draft?.market,variants=strategyVariants(s.id),tabLabels=[['plan','交易方案','Trade plan'],['parameters','规则参数','Parameters'],['abc','运行与保护','Run & protection']];
  const liveRoute=liveBinanceSpotRoute(executionRoute,executionRoute?.market);
  const picker=variants.length?`<label class="sc-version-picker">${L('版本','Version')}<select ${!['configure','overview'].includes(phase)?'disabled':''} data-plan-variant data-sc="variant-select" aria-label="${L('策略版本','Strategy version')}"><option value="baseline" ${p.variant==='baseline'?'selected':''}>${L('原版','Baseline')}</option>${variants.map(v=>`<optgroup label="${e(liveRoute&&['S01-SIM','S02-SIM'].includes(v.id)?L('币安现货方案','Binance spot plan'):v.id+' · '+L(...v.name))}"><option value="${v.id}" title="${e(L(...v.name))}" ${p.variant===v.id?'selected':''}>${['S01-SIM','S02-SIM'].includes(v.id)?liveRoute?L('币安现货','Binance spot'):L('模拟版','Simulation'):e(v.id)}</option></optgroup>`).join('')}</select></label>`:`<span class="sc-version-baseline">${L('原版','Baseline')}</span>`;
  const header=`<div class="sc-plan-profile"><span>${instrument?tokenIcon(instrument.split('/')[0],{size:25}):scIcon(scope.icon)}<b>${instrument?e(instrument):L(...scope.label)}</b>${instrument?`<small>${L(...p.market)}</small>`:''}</span>${picker}</div><nav class="sc-plan-tabs" role="tablist" aria-label="${L('策略详情','Strategy details')}">${tabLabels.map(([id,z,en])=>`<button type="button" role="tab" id="sc-plan-${id}" aria-controls="sc-plan-panel" aria-selected="${planTab===id}" data-sc="plan-tab" data-id="${id}">${L(z,en)}</button>`).join('')}</nav>`;
  let body;
  if(nativeEditor()){
   if(planTab==='parameters')body=botParameterFacts(nativePlan());
   else if(planTab==='abc')body=botProtectionRows(nativePlan()).length?facts(botProtectionRows(nativePlan())):rules(s);
   else body='<div class="sw-rule-map"><article><h4>'+uiGlyph('chart')+L('买入条件','Entry conditions')+'</h4><p>'+e(L(...p.entry))+'</p></article><article><h4>'+uiGlyph('shield')+L('退出与保护','Exit & protection')+'</h4><p>'+e(L(...p.exit))+'</p></article></div>';
  }
  else if(planTab==='parameters')body=executionParameters(p);
  else if(planTab==='abc')body=executionABC(p);
  else body=(p.candidate?`<div class="sc-candidate-change"><b>${e(L(...p.candidate.name))}</b><p>${e(L(...p.candidate.change))}</p></div>`:'')+botTemplateOverview({art:strategyArt(s.id),description:L(...scText(s).slice(2,4)),entry:L(...p.entry),exit:L(...p.exit),scope:L(...scope.label),timeframe:strategyTimeframe(s),reference:p.symbol.includes('/')?p.symbol:p.symbol+'/USDT',ready:nativeEditor()&&p.flowAvailable,need:L(...(p.candidate?.need||p.need)),version:p.baseVersion});
  if(!nativeEditor()&&planTab==='plan'&&s.id==='S01'&&!inlineHost)body+=`<details class="bot-grid-chart"><summary>${L('K 线与网格预览','Candles & grid preview')}${uiGlyph('chevron')}</summary>${tradingChartPanel('strategy-grid-preview',{...executionRoute,gridPreview:true,gridPlan:gridPreviewPlan(),planRef:{id:opened.draftId||'editor:'+s.id,version:draft?.version||'unsaved'}})}</details>`;
  return `<div class="sc-execution-plan">${header}<div id="sc-plan-panel" role="tabpanel" aria-labelledby="sc-plan-${planTab}">${body}</div></div>`;
 }
 function nativeAvailable(){
  const data=desk.readSnapshot?.()||desk.snapshot();
  const live=spendableSpotUsdt(data?.connections,executionRoute,w.s.risk.cap);
  if(live!==null)return live;
  const wallet=spendableWalletUsdt(data?.connections,executionRoute,w.s.risk.cap);
  if(wallet!==null)return wallet;
  const sync=desk.syncStatus?.();
  if(!executionRoute?.accountId||!strategyConnection(executionRoute,data?.connections)||sync?.state!=='LIVE'||sync.scope?.accountId!==executionRoute.accountId||sync.scope?.environment!=='DEMO'||data?.botSummary?.recoveryError||data?.cash==null||!Number.isFinite(Number(data.cash)))return null;
  const legacy=data.discovery?.armed?Number(w.draft(data.discovery.draftId)?.cap||0):data.session&&data.state!=='stopped'?Number(data.session.cap||0):Number(data.position?.cost||0);
  return Math.max(0,Math.min(Number(data.cash),w.s.risk.cap-Number(data.botSummary?.allocated||0)-legacy));
 }
 function nativeConfiguration(s){
  const plan=nativePlan(),currency=executionRoute.market?.split('/')[1]||'USDT',data=desk.snapshot(),available=nativeAvailable(),walletBook=data?.connections?.walletBook,walletLive=spendableWalletUsdt(data?.connections,executionRoute,w.s.risk.cap)!==null,liveSpot=spendableSpotUsdt(data?.connections,executionRoute,w.s.risk.cap)!==null||walletLive,heldBtc=walletLive&&walletBook?.accountId===executionRoute.accountId?walletBook.btc:data?.connections?.spotBook?.symbol==='BTCUSDT'?data.connections.spotBook.btc:null,canAllocate=available!==null&&available>=MIN_ORDER_USDT&&(liveSpot||strategyRouteConnected(executionRoute,data.connections,routeAccess()));
  const moneyField=(name,label,min,max)=>`<label class="sc-field bot-amount-field">${label}<span><input name="${name}" aria-label="${label}" type="number" inputmode="decimal" min="${min}" max="${max}" step="any" ${name==='cap'?'required':`placeholder="${L('自动分配','Auto')}"`} value="${e(name==='cap'?cap:amount)}"><b>${e(currency)}</b></span>${name==='amount'?`<small>${L('留空时按总金额、买入安排及手续费自动计算；填写后保留你的金额。','Leave blank to size from allocation, entries and fees. A custom amount stays unchanged.')}</small>`:''}</label>`;
  const liveAccount=liveBinanceSpotRoute(executionRoute,executionRoute.market)&&executionRoute.market==='BTC/USDT'&&opened?.id==='S01',walletAccount=liveWalletSpotRoute(executionRoute,executionRoute.market)&&opened?.id==='S01';
  return `<form id="sc-config" class="bot-native-config">${inlineHost?mobileInstrument():''}${strategyRouteFields(opened.id,executionRoute,data.connections,routeAccess(),opened.variant,Boolean(inlineHost))}${moneyField('cap',L('策略总金额','Strategy allocation'),MIN_ORDER_USDT,w.s.risk.cap)}<div class="bot-allocation-shortcuts"><span>${L('可分配额度','Available allocation')} <b>${available===null?L(executionRoute.accountId?'额度暂不可用':'选择账户后显示',executionRoute.accountId?'Balance unavailable':'Select an account to view'):amountFormat(available)+' USDT'+(Number.isFinite(heldBtc)&&heldBtc>0?' · '+Number(heldBtc).toLocaleString('en-US',{maximumFractionDigits:8})+' BTC':'')}</b></span><div>${[.25,.5,.75,1].map(fraction=>`<button type="button" data-sc="allocation" data-id="${fraction}" ${!canAllocate?'disabled':''}>${fraction*100}%</button>`).join('')}</div></div><p class="bot-funding-note" data-bot-funding></p><p class="bot-range-note" data-bot-range-note role="status"></p><details class="bot-plan-settings" data-bot-section="parameters"><summary><span><b>${L('交易参数','Trading parameters')}</b><span class="bot-plan-summary" data-bot-parameter-summary>${nativeParameterSummary()}</span></span><span class="bot-detail-action">${L('调整','Adjust')}${uiGlyph('chevron')}</span></summary><div>${botParameterFields(plan,parameterSource,parameterReference?.closedPrice||liveParameterQuote?.closedPrice)}${moneyField('amount',L(s.id==='S01'?'每格买入金额':'首笔买入金额',s.id==='S01'?'Amount per grid':'Initial entry amount'),MIN_ORDER_USDT,1000)}</div></details>${protectionOptions(s)}<input type="hidden" name="mode" value="auto"><p class="bot-native-authorization">${liveAccount?L('此共享账户供查看行情及保存策略方案。','Use this shared account to review the market and save plans.'):walletAccount?L('方案将保存在当前钱包名下。','Your plan will be saved for this wallet.'):L('规则内订单自动执行；重要规则变更重新批准','Orders follow approved rules; material changes need a new approval')}</p><details class="sc-rules sc-config-advanced"><summary>${L('账户保护与费用','Account protection & fees')}</summary>${facts([[L('账户总上限','Account limit'),w.s.risk.cap+' USDT'],[L('账户亏损暂停线','Account loss pause limit'),w.s.risk.dailyLoss+' USDT'],[L('设置与启动','Setup & start'),L('免费','Free')],[liveAccount?L('币安现货手续费','Binance spot fee'):L('模拟手续费','Paper trading fee'),liveAccount?L('按成交记录','Recorded on each fill'):'0.10%']])}<p>${liveAccount?L('币安现货方案','Binance spot plan'):e(opened.variant)} · ${e(plan.version||plan.baseVersion||'')}</p><p>${simulationBoundary(desk.syncStatus?.().source).notice}</p></details></form>`;
 }
 const amountFormat=value=>Number(value||0).toLocaleString('en-US',{maximumFractionDigits:2});
 function configureActions(){
  const linked=strategyConnection(executionRoute,desk.snapshot()?.connections)?.status==='connected';
  const needsAccess=executionRoute.connectionId&&desk.access&&!routeAccess().ready&&!linked;
  const paperStart=nativeEditor()&&executionRoute.accountId==='SIM-01'&&routeAccess()?.ready?scBtn(L('启动','Launch'),'start','',true):'';
  return scBtn(L('保存方案','Save plan'),'save-plan')+scBtn(L('查看','View'),'view-list')+(needsAccess?scBtn(L('连接账户','Connect account'),'route-connect','',true):paperStart);
 }
 function renderDrawer(){if(!opened){const item=BOT_PRODUCT_CAPABILITIES.find(p=>'product:'+p.id===workspaceSelection);if(item)renderCapability(item);return;}const priorPhase=drawer.dataset.phase,priorScroll=editorScrollElement()?.scrollTop||0;disposeBotCharts();const s=strategyById(opened.id),d=opened.draftId?w.draft(opened.draftId):null,v=d?w.s.validations.find(v=>v.id===d.validationId):null;let content='',actions='';const plan=strategyPlan(s.id,opened.variant),ready=nativeEditor()&&plan.flowAvailable;if(!ready&&phase==='check')phase='configure';

  if(phase==='resume'){
   const saved=pendingEditor?.editor,savedNative=isBotSimulation({strategy:s.id,planVariant:saved?.variant})&&strategyPlan(s.id,saved.variant).flowAvailable;
   content='<section class="sw-resume"><h3>'+L(savedNative?'继续模拟草稿？':'继续研究草稿？',savedNative?'Continue the simulation draft?':'Continue the research draft?')+'</h3><p>'+L(!savedNative&&ready?'这份旧稿用于研究。新建模拟方案会保留原稿。':'继续原版本，或另建方案；原稿会保留。',!savedNative&&ready?'This saved draft is for research. A new simulation plan keeps the original draft.':'Continue the original version or create a separate plan. The original draft is kept.')+'</p>'+facts([[L('原版本','Saved version'),e(saved?.variant||'baseline')],[L('草稿','Draft'),e(saved?.draftId||L('草稿','Draft'))],[L('账户','Account'),e(saved?.executionRoute?.accountId||'—')],[L('交易资产','Instrument'),e(saved?.executionRoute?.market||'—')],[L('投入上限 / 每次买入','Allocation / per entry'),e(saved?.cap??'—')+' / '+e(saved?.amount??'—')]])+'</section>';
   actions=scBtn(L(ready?'新建模拟方案':'新建研究方案',ready?'New simulation plan':'New research plan'),'new-editor')+scBtn(L(savedNative?'继续模拟草稿':'继续研究草稿',savedNative?'Continue simulation draft':'Continue research draft'),'resume-editor','',true);
  }
  else if(phase==='overview'){
   content=executionOverview(s,plan);
   actions=(ready?'':scBtn(L('保存研究方案','Save research plan'),'save-research',s.id))+scBtn(L(ready?'使用这套策略':'配置方案',ready?'Use this strategy':'Configure plan'),'configure',s.id,true);
  }
  else if(phase==='configure'&&nativeEditor()){content=nativeConfiguration(s);actions=configureActions();}
  else if(phase==='configure'){content=`<form id="sc-config">${inlineHost?mobileInstrument():''}${strategyRouteFields(opened.id,executionRoute,desk.snapshot()?.connections,routeAccess(),opened.variant,Boolean(inlineHost))}${['S01','S02'].includes(s.id)?`<div class="bot-family-rules">${layerPreview(plan)}</div>`:''}<label class="sc-field bot-amount-field">${L('这套策略最多使用','Strategy allocation')}<span><input name="cap" aria-label="${L('策略总金额','Strategy allocation')}" type="number" min="${MIN_ORDER_USDT}" max="${w.s.risk.cap}" step="any" required value="${cap}">${executionRoute.market?`<b>${e(executionRoute.market.split('/')[1])}</b>`:''}</span>${executionRoute.market?'':`<small>${L('选择资产后显示币种','Currency follows the selected instrument')}</small>`}</label><label class="sc-field bot-amount-field">${L('每次买入多少','Amount per entry')}<span><input name="amount" aria-label="${L('单笔金额','Amount per entry')}" type="number" min="${MIN_ORDER_USDT}" max="1000" step="any" ${nativeEditor()?'':'required'} value="${amount}">${executionRoute.market?`<b>${e(executionRoute.market.split('/')[1])}</b>`:''}</span>${executionRoute.market?'':`<small>${L('选择资产后显示币种','Currency follows the selected instrument')}</small>`}</label><input type="hidden" name="mode" value="signal"><p class="ux-inline-note">${L('保存这份研究配置不会启动交易。','Saving this research setup does not start trading.')}</p>${protectionOptions(s)}<details class="sc-rules sc-config-advanced"><summary>${L('更多设置','More settings')}</summary><label class="sc-field sc-research-budget">${L('每日自动研究上限','Daily automatic research limit')}<span><input name="researchBudget" inputmode="numeric" aria-label="${L('每日研究积分上限','Daily research credit limit')}" type="number" min="0" max="10000" step="1" required value="${researchBudget}"><b>${L('AI 积分','AI credits')}</b></span><small>${L('设定上限，不会自动扣积分；设为 0 暂停自动研究。','A limit does not spend credits. Set 0 to pause automatic research.')}</small></label>${facts([[L('账户','Account'),e(executionRoute.accountId||L('未选择','Not selected'))],[L('账户总上限','Account limit'),w.s.risk.cap+' USDT'],[L('当前环境','Environment'),e(w.s.setupContext.environment)],[L('账户累计亏损暂停线','Account loss pause limit'),`${w.s.risk.dailyLoss} USDT`],[L('自动研究今日剩余','Automatic research remaining today'),`${w.account?(w.account.budget.remaining??'—'):Math.max(0,w.s.budget.daily-w.todayUsage)} ${L('AI 积分','AI credits')}`]])}<p>${L('沿用账户保护。全局保护变更后须重新检查；保存此研究方案不会启动交易。','Uses account protection. Recheck after changes; saving this research plan does not start trading.')}</p></details>${creditSummary(w,researchBudget)}</form>`;actions=configureActions();}
  else if(phase==='check'){
   const checking=v?.status==='running',fresh=v?.status==='passed'&&w.s.selectedDraftId===d?.id&&w.setupReady?.id===v.id;
   content=nativeEditor()?`<div class="bot-approval bot-review">
    <header><span class="sc-tag">${checking?L('正在检查','Checking'):fresh?L('待你批准','Awaiting approval'):L('需要重新检查','Check again')}</span><h3>${L(checking?'正在核对这份方案':'确认这份方案',checking?'Checking this plan':'Review this plan')}</h3></header>
    <div class="bot-review-hero">${d?.market?tokenIcon(d.market.split('/')[0],{size:32}):''}<div><b>${e(d?.market||'—')}</b><span>${strategyName(s)}</span></div><strong>${e(d?.cap??'—')}<small>${e(d?.market?.split('/')[1]||'USDT')}</small></strong></div>
    ${facts([[L('使用账户','Account'),e(d?.executionRoute?.accountId||'—')+' · '+e(strategyVenues(d?.executionRoute?.profileId||'cex-spot').find(venue=>venue.id===d?.executionRoute?.venueId)?.name||d?.executionRoute?.venueId||'—')],[L('资金保护','Protection'),d?.protection?.id==='astarter'?'Astarter · '+L(d.protection.mode==='conservative'?'保守':'正常',d.protection.mode==='conservative'?'Conservative':'Normal'):L('原有策略保护','Original strategy protection')]])}
    ${botParameterFacts(d)}
    ${d?.simulationReference?`<p class="bot-review-reference">${desk.parameterQuote?L('本机模拟参考价','Local simulation reference'):L('模拟起点','Simulation start price')} · ${formatTradingPrice(d.simulationReference.closedPrice)} USDT<br>${formatDataTime(d.simulationReference.closedAt)} · ${desk.parameterQuote?L('本机模拟服务报价 · 读取时间','Local synthetic quote · received at'):L('后续按独立模拟行情运行','A separate simulated market drives this run.')}</p>`:''}
    <p class="bot-review-fees">${L('设置与启动','Setup & start')} · ${L('免费','Free')}<span>${liveBinanceSpotRoute(d?.executionRoute,d?.market)?L('币安现货手续费','Binance spot fee')+' · '+L('按成交记录','Recorded on each fill'):L('模拟手续费','Paper trading fee')+' · 0.10%'}</span></p>
    <p class="bot-native-authorization">${L('规则内订单自动执行；重要规则变更重新批准','Orders follow approved rules; material changes need a new approval')}</p>
    <details class="sc-rules sc-config-advanced" data-bot-section="review"><summary>${L('方案详情','Plan details')}${uiGlyph('chevron')}</summary>
     ${facts([[L('草稿','Draft'),e(d?.id||'—')+' · v'+e(d?.version||1)],[L('交易接入','Trading connection'),e(d?.executionRoute?.connectionId||'—')],[L('账户亏损暂停线','Account loss pause limit'),w.s.risk.dailyLoss+' USDT'],...(d?.advisor?[[L('草稿期望暂停线 · 未应用','Requested pause limit · not applied'),d.advisor.dailyLoss+' USDT']]:[]),[L('结束时资产处理','Assets when ending'),L('结束时确认留仓或卖出','Choose keep holdings or sell when ending')],[L('授权范围 / 时效','Scope / duration'),simulationBoundary(desk.syncStatus?.().source).scope]])}
     <div class="bot-approval-rule"><h4>${L('买入与退出规则','Entry & exit rules')}</h4><p>${e(L(...plan.entry))}</p><p>${e(L(...plan.exit))}</p></div><p>${e(plan.baseVersion)} · ${liveBinanceSpotRoute(d?.executionRoute,d?.market)?L('币安现货方案','Binance spot plan'):e(opened.variant)}</p><p>${simulationBoundary(desk.syncStatus?.().source).notice}</p>
    </details>
    ${checking?`<progress max="100" value="${v.progress||0}"></progress>`:!fresh?`<p role="status">${L('设置或账户状态已变化，返回草稿重新检查。','Settings or account access changed. Return to the draft and check again.')}</p>`:''}
   </div>`:`<div class="bot-approval"><header><span class="sc-tag">${checking?L('正在检查','Checking'):fresh?L('待你批准','Awaiting approval'):L('需要重新检查','Check again')}</span><h3>${L(checking?'正在核对这份方案':'确认这份方案',checking?'Checking this plan':'Review this plan')}</h3><p>${e(d?.id||'')} · v${d?.version||1} · ${e(plan.baseVersion)}</p></header>${facts([[L('使用账户','Account'),e(d?.executionRoute?.accountId||'—')],[L('交易接入','Trading connection'),e(d?.executionRoute?.connectionId||'—')],[L('交易对象 / 方向','Instrument / direction'),e(routeSummary({...d?.executionRoute,market:d?.market}))+' · '+L('现货做多','Spot long')],[L('投入上限 / 每次买入','Allocation / per entry'),`${d?.cap} / ${d?.amount} ${e(d?.market?.split('/')[1]||'USDT')}`],[L('执行方式','Execution'),nativeEditor()?L('批准方案后运行','Run the approved plan'):L(...modes[d?.mode||'auto'])],[L('资金保护','Protection'),d?.protection?.id==='astarter'?'Astarter · '+L(d.protection.mode==='conservative'?'保守':'正常',d.protection.mode==='conservative'?'Conservative':'Normal'):L('原有策略保护','Original strategy protection')],[L('账户亏损暂停线','Account loss pause limit'),`${w.s.risk.dailyLoss} USDT`],...(d?.advisor?[[L('草稿期望暂停线 · 未应用','Requested pause limit · not applied'),`${d.advisor.dailyLoss} USDT`]]:[]),[L('结束时资产处理','Assets when ending'),nativeEditor()?L('结束时确认留仓或卖出','Choose keep holdings or sell when ending'):L('结束留仓；退出需另行确认','Keep holdings; confirm liquidation separately')],[L('授权范围 / 时效','Scope / duration'),simulationBoundary(desk.syncStatus?.().source).scope]])}${nativeEditor()?botParameterFacts(d):''}<div class="bot-approval-rule"><h4>${L('买入与退出规则','Entry & exit rules')}</h4><p>${e(L(...plan.entry))}</p><p>${e(L(...plan.exit))}</p></div>${nativeEditor()?'<p class="bot-paper-note">'+L('独立纸面模拟；费用按 0.10% 计入本实例。','Independent paper simulation. A 0.10% fee is recorded in this instance.')+'</p>':creditSummary(w,researchBudget)}<div class="bot-cost-note"><b>${L('交易手续费 / 滑点','Trading fees / slippage')}</b><span>${L('按模拟成交记录；真实费率与滑点待接入','Recorded per simulated fill; live fee and slippage data unavailable')}</span></div>${checking?`<progress max="100" value="${v.progress||0}"></progress>`:!fresh?`<p role="status">${L('设置或账户状态已变化，返回草稿重新检查。','Settings or account access changed. Return to the draft and check again.')}</p>`:''}</div>`;
   actions=checking?scBtn(L('取消检查','Cancel check'),'cancel'):fresh?`${scBtn(L('修改设置','Edit settings'),'configure')}${scBtn(L('启动模拟','Start simulation'),'launch','',true)}`:scBtn(L('返回草稿','Back to draft'),'configure','',true);
  }
  else if(phase==='unknown'){content=`<div class="bot-approval"><h3>${L('启动结果待核对','Start result unconfirmed')}</h3><p>${L('保留原请求，确认前不会再次启动。','The original request is retained. No duplicate start will be sent.')}</p>${facts([[L('启动请求','Start request'),e(d?.botLaunch?.requestId||'—')],[L('账户','Account'),e(d?.executionRoute?.accountId||'—')],[L('方案版本','Plan version'),`v${d?.version}`]])}</div>`;actions=scBtn(L('查询启动结果','Check start result'),'query-start','',true);}
  else if(phase==='ended'){content=`<div class="bot-approval"><h3>${L(d?.botLaunch?.status==='interrupted'?'页面模拟已中断':d?.botLaunch?.status==='failed'?'启动未完成':d?.botLaunch?.runId?'运行已结束':'机会观察已关闭',d?.botLaunch?.status==='interrupted'?'Browser simulation interrupted':d?.botLaunch?.status==='failed'?'Start failed':d?.botLaunch?.runId?'Run ended':'Opportunity watch stopped')}</h3><p>${L('这次请求已结束。重新检查并批准后才能再次开始。','This request has ended. Check and approve the plan again before restarting.')}</p>${facts([[L('账户','Account'),e(d?.executionRoute?.accountId||'—')],[L('交易资产','Instrument'),e(d?.market||'—')],[L('方案版本','Plan version'),`v${d?.version}`],[L('启动请求','Start request'),e(d?.botLaunch?.requestId||'—')]])}</div>`;actions=scBtn(L('查看运行','View activity'),'navigate','execution')+scBtn(L(ready?'编辑并重新检查':'查看原方案',ready?'Edit & check again':'View original plan'),'configure','',true);}
  else if(phase==='stop'){const snap=desk.snapshot();content=`<h3 class="sc-check-title">${L('停止这次模拟运行？','Stop this simulation?')}</h3><p class="sc-muted">${L('停止接收新信号，撤销能够确认的未成交订单。已有持仓不会自动卖出，仍可在交易枢纽处理。','Stop new signals and cancel confirmed unfilled orders. Existing holdings are not sold; manage them in Trading.')}</p>${facts([[L('已有持仓','Holdings'),snap.position?`${snap.session.market} · ${Number(snap.position.qty).toLocaleString('en-US',{maximumFractionDigits:8})}`:L('无','None')],[L('等待完成的订单','Pending order'),snap.pending?.id||L('无','None')]])}`;actions=`${scBtn(L('返回','Back'),'close')}${scBtn(L('确认停止模拟','Confirm stop'),'confirm-stop','',true)}`;}
  else if(nativeEditor()){const run=desk.snapshot().botBook?.runs?.find(run=>run.id===d?.botLaunch?.runId);content='<div class="sc-check-icon done">✓</div><h3 class="sc-check-title">'+L('模拟 Agent 已创建','Simulation Agent created')+'</h3>'+facts([[L('实例编号','Instance ID'),e(run?.id||'—')],[L('状态','Status'),botInstanceStatus(run?.status||'waiting')],[L('账户','Account'),e(run?.plan.executionRoute.accountId||'—')],[L('策略总金额','Strategy allocation'),amountFormat(run?.initialAllocation)+' USDT']])+botParameterFacts(run?.plan||d);actions=scBtn(L('继续创建','Create another'),'new-editor')+scBtn(L('查看运行','View activity'),'navigate','execution',true);}
  else {content=`<div class="sc-check-icon done">✓</div><h3 class="sc-check-title">${L(d?.botLaunch?.status==='started'?'已创建运行实例':'已开启机会观察',d?.botLaunch?.status==='started'?'Run instance accepted':'Now watching for opportunities')}</h3>${facts([[L('出现信号后','On a signal'),L(...modes[d?.mode||'confirm'])],[L('每次买入','Per entry'),`${d?.amount} USDT`],[L('最多使用','Allocation'),`${d?.cap} USDT`]])}<div class="sc-launch-balance"><span>${L('可用积分','Available credits')} <b>${w.available} ${L('AI 积分','AI credits')}</b></span>${scBtn(L('积分记录','Credit history'),'navigate','billing')}</div>`;actions=`${scBtn(L('查看运行','View activity'),'navigate','execution')}${scBtn(L('完成','Done'),'close','',true)}`;}
  const editorLinks=(returnToCaller?scBtn(L(opened?.source||workspaceSource?'返回来源':'返回列表',opened?.source||workspaceSource?'Back to source':'Back to list'),'return-source'):'')+(opened.previousEditorKey&&phase==='configure'?scBtn(L('返回原草稿','Return to draft'),'restore-previous'):'');
  const adoptedRules=phase==='configure'&&opened.source?.recommendationId?'<details class="sc-rules" data-bot-section="recommendation" open><summary>'+L('已采用的策略规则','Applied strategy rules')+uiGlyph('chevron')+'</summary>'+facts([[L('策略版本','Strategy version'),e(plan.variant==='baseline'?L('原版','Baseline'):plan.variant)],[L('执行周期','Timeframe'),e(strategyTimeframe(s))],[L('入场条件','Entry conditions'),e(L(...plan.entry))],[L('退出与保护','Exit & protection'),e(L(...plan.exit))]])+'<p>'+L('规则与参数沿用所选版本的模板默认值；账户和投入金额由你确认。','Rules and parameters use the selected template version. Confirm the account and allocation.')+'</p></details>':'';
  content=sourceNotice(opened.source)+(editorLinks?'<div class="sw-context-actions">'+editorLinks+'</div>':'')+memoryPanel()+adoptedRules+content;
  if(phase==='configure'&&!inlineHost)content=botCreationFrame({content,strategyId:s.id,nativeBot:nativeEditor(),chartIdentity:botChartIdentity(),view:nativeEditor()?null:configView,market:executionRoute.market,profileId:executionRoute.profileId,venueId:executionRoute.venueId,mobileView,gridPlan:gridPreviewPlan(),planRef:{id:opened.draftId||'editor:'+s.id,version:d?.version||'unsaved'},limit:strategyRouteReady(executionRoute,opened?.variant)&&strategyRouteConnected(executionRoute,desk.snapshot()?.connections,routeAccess())?Math.min(w.s.risk.cap,Number(desk.snapshot()?.cash??0)):null,entry:L(...plan.entry),exit:L(...plan.exit)});
  const wizard=!['overview','stop'].includes(phase),current=['configure','resume'].includes(phase)?0:1;
  drawer.classList.toggle('sc-wizard',wizard);drawer.dataset.phase=phase;drawer.dataset.family=s.id;drawer.dataset.variant=opened.variant;
  const closeIcon=uiGlyph('close');
  const steps=wizard?`<nav class="sc-wizard-steps" aria-label="${L('配置进度','Setup progress')}"><div class="sc-progress-track" aria-hidden="true"><i style="transform:scaleX(${current})"></i></div>${[['配置方案','Configure plan'],ready?['确认并开始','Confirm & start']:['查看方案','Review plan']].map(([z,en],i)=>`<div aria-current="${i===current?'step':'false'}" class="${i<current?'complete':''}"><span>${i<current?'✓':i+1}</span><b>${L(z,en)}</b></div>`).join('')}</nav>`:'';
  const focusWasInside=drawer.contains?.(document.activeElement);
  const focused=document.activeElement?.dataset?.sc,focusedId=document.activeElement?.dataset?.id,focusedRoute=document.activeElement?.dataset?.strategyRoute;
  drawer.querySelectorAll('.strategy-art').forEach(el=>artObserver.unobserve(el));
  const riskPreviewOpen=drawer.querySelector('.sc-risk-explainer')?.open,protectionOpen=drawer.querySelector('.sc-protection-settings')?.open,expandedSections=[...drawer.querySelectorAll('details[data-bot-section][open],details.bot-native-advanced[open]')].map(el=>el.dataset.botSection||'native-advanced');

  const heading='<div class="sc-drawer-head"><div><h2 id="sc-drawer-title">'+strategyName(s)+'</h2>'+(phase==='configure'&&plan.candidate&&!nativeEditor()?'<small class="bot-editor-version">'+e(opened.variant)+' · '+e(L(...plan.candidate.name))+'</small>':'')+(phase==='configure'?'<span class="bot-editor-status">'+L(w.persistenceError?'保存未完成':opened.source?(opened.source.recommendationId?'建议已采用':'已带入来源'):opened.restored?'已恢复配置':'创建 Agent',w.persistenceError?'Save incomplete':opened.source?(opened.source.recommendationId?'Recommendation applied':'Source attached'):opened.restored?'Setup restored':'Create Agent')+'</span>':'')+'</div>'+(!inlineHost?'<button class="sc-close" data-sc="close" aria-label="'+L('关闭策略设置','Close strategy setup')+'">'+closeIcon+'</button>':'')+'</div>';
  const access=(phase==='check'&&(!nativeEditor()||!routeAccess()?.ready)||phase==='configure'&&!nativeEditor()&&ready&&executionRoute.accountId&&strategyRouteReady(executionRoute,opened?.variant))?accessPanel(routeAccess(),{compact:true}):'';
  const note='<p class="sc-feedback" data-tone="'+feedbackTone+'" role="'+(feedback&&feedbackTone==='error'?'alert':'status')+'">'+e(feedback)+(feedback&&feedbackTone==='error'&&['configure','check'].includes(phase)&&desk.access&&!routeAccess().ready&&feedback===accessMessage(routeAccess())?scBtn(L('检查接入','Check access'),'resolve-access'):'')+'</p>';
  const footer='<footer class="sc-drawer-footer">'+note+actions+'</footer>';
  if(inlineHost){
   drawer.innerHTML=botCreationFrame({content:access+content,strategyId:s.id,nativeBot:nativeEditor(),chartIdentity:botChartIdentity(),view:phase==='configure'&&!nativeEditor()?configView:null,market:executionRoute.market,profileId:executionRoute.profileId,venueId:executionRoute.venueId,mobileView,gridPlan:gridPreviewPlan(),planRef:{id:opened.draftId||'editor:'+s.id,version:d?.version||'unsaved'},limit:strategyRouteReady(executionRoute,opened?.variant)&&strategyRouteConnected(executionRoute,desk.snapshot()?.connections,routeAccess())?Math.min(w.s.risk.cap,Number(desk.snapshot()?.cash??0)):null,entry:L(...plan.entry),exit:L(...plan.exit),embedded:{header:heading,footer,instrumentPicker:phase==='configure',empty:phase==='resume'?'<div class="bot-market-empty"><div class="bot-market-mechanism">'+strategyArt(s.id)+'</div><h3>'+L('恢复已保存的草稿？','Resume the saved draft?')+'</h3><p>'+L('继续编辑已有草稿，或新建一份配置。新建不会覆盖原方案。','Continue the saved draft or start a new setup. A new setup keeps the original plan.')+'</p></div>':undefined,details:'<section class="sw-plan-section" tabindex="-1">'+executionOverview(s,plan)+'</section>',art:strategyArt(s.id)}});
  }else drawer.innerHTML=heading+steps+'<div class="sc-drawer-body"><div class="sc-wizard-content">'+access+content+'</div></div>'+footer;
  drawer.querySelector('[data-plan-variant]')?.addEventListener('change',event=>{capture();opened.variant=event.target.value;if(nativeEditor()){mode='auto';loadBotParameters();}invalidateCheck();remember();planTab='plan';planScenario='A';feedback='';renderDrawer();});drawer.querySelector('#sc-config')?.addEventListener('invalid',ev=>{for(let detail=ev.target.closest('details');detail;detail=detail.parentElement?.closest('details'))detail.open=true;},true);if(protectionOpen&&drawer.querySelector('.sc-protection-settings'))drawer.querySelector('.sc-protection-settings').open=true;if(riskPreviewOpen&&drawer.querySelector('.sc-risk-explainer'))drawer.querySelector('.sc-risk-explainer').open=true;if(phase==='configure'&&configView==='full'){const advanced=drawer.querySelector('.sc-config-advanced');if(advanced)advanced.open=true;}drawer.querySelectorAll('details[data-bot-section],details.bot-native-advanced').forEach(el=>{if(expandedSections.includes(el.dataset.botSection||'native-advanced'))el.open=true;});observeArt(drawer);if(drawer.open&&(!inlineHost||focusWasInside)){const same=focusedRoute?[...drawer.querySelectorAll('[data-strategy-route]')].find(x=>x.dataset.strategyRoute===focusedRoute):focused?[...drawer.querySelectorAll('[data-sc]')].find(x=>x.dataset.sc===focused&&x.dataset.id===focusedId):null;const target=same||drawer.querySelector('.sc-step-heading h3')||drawer.querySelector('.sc-check-title')||drawer.querySelector('h2');if(target){if(!same)target.tabIndex=-1;target.focus({preventScroll:true});}}if(priorPhase===phase&&editorScrollElement())editorScrollElement().scrollTop=priorScroll;if(drawer.open)disposeBotCharts=mountBotCharts();updateBotPreview();paintSubmission();

 }
 function capture(event){const form=drawer.querySelector('#sc-config');if(form){const f=Object.fromEntries(new FormData(form));amount=f.amount;cap=f.cap;mode=f.mode||mode;researchBudget=f.researchBudget??researchBudget;if(nativeEditor()){for(const [key,value]of Object.entries(f))if(key.startsWith('bot_'))botParameters[key.slice(4)]=value;if(event?.target?.matches('[data-bot-parameter]')){parameterSource='manual';parameterReference=null;checkedParameterQuote=null;updateQuoteControls(liveParameterQuote);const recommendation=drawer.querySelector('.bot-recommendation');if(recommendation)recommendation.hidden=true;drawer.querySelectorAll('[data-sc=parameter-source]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.id==='manual')));}updateBotPreview();}remember();return form;}return null;}
 function paintSubmission(){
  const busy=Boolean(submission&&submission===opened);
  drawer.setAttribute('aria-busy',String(busy));
  const form=drawer.querySelector('#sc-config');if(form)form.inert=busy;
  if(!busy)return;
  for(const button of drawer.querySelectorAll('[data-sc]:not([data-sc="close"])'))button.disabled=true;
  const note=drawer.querySelector('.sc-feedback');if(note){note.textContent=['check','unknown'].includes(phase)?L('启动结果待核对','Start result unconfirmed'):L('正在保存设置…','Saving settings…');note.setAttribute('role','status');}
 }
 async function save(check,context=opened){
  if(check&&!nativeEditor()){feedback=L('该版本仅可保存研究方案，尚未开放创建模拟。','This version is available for research only. Simulation creation is not enabled.');phase='configure';renderDrawer();return;}
  if(check&&(!strategyPlan(context.id,context.variant).flowAvailable||executionRoute.market&&executionRoute.accountId&&!strategyRouteReady(executionRoute,opened?.variant))){feedback=L('所选交易路线暂不支持启动，可以先保存配置。','This trading route cannot run yet. Save the configuration first.');renderDrawer();return;}
  const form=capture(),instrumentIssue=sourceInstrumentIssue(context.source);if(instrumentIssue){feedback=instrumentIssue;renderDrawer();return;}if(!check&&(!executionRoute.connectionId||!executionRoute.accountId||!executionRoute.market)){remember();const key=context.editorKey||context.id,editor=loadBotEditors(w)[key],saved=editor&&saveBotEditor(w,{...editor,localSaved:{scope:w.account?.scope||'local',environment:w.s.setupContext?.environment||'DEMO'}},key);if(!saved){if(editor&&!editor.localSaved)delete w.s.botEditors[key].localSaved;feedback=L('本机草稿尚未确认保存，输入已保留。请检查浏览器存储后重试。','The local draft could not be confirmed saved. Your inputs are retained. Check browser storage and try again.');renderDrawer();return;}acceptEditor();const message=L('草稿已保存，可在“我的 Agent”继续配置。','Draft saved. Continue setup in My Agents.');if(inlineHost){feedback=message;feedbackTone='success';}else{drawer.close();refresh();notify(message,{tone:'success',action:()=>route('execution'),actionLabel:L('我的 Agent','My Agents')});}return;}if(form&&!form.reportValidity())return;const resolvedAmount=nativeEditor()?nativePlan().amount:Number(amount);if(amount!=='')amount=Number(amount);cap=Number(cap);researchBudget=Number(researchBudget);
  if(check){const issue=recommendationIssue(context.source);if(issue){feedback=issue;renderDrawer();return;}}
  if(!executionRoute.connectionId||!executionRoute.accountId||!strategyRouteValid(context.id,executionRoute)){feedback=L('请选择账户、交易市场和资产。','Select an account, market and trading pair.');renderDrawer();return;}
  if(context.draftId&&(desk.snapshot().botBook?.runs?.some(run=>run.plan.id===context.draftId&&!['stopped','failed'].includes(run.status))||context.draftId===activeId()||['requested','unknown'].includes(w.draft(context.draftId)?.botLaunch?.status))){feedback=L('运行中的方案不能覆盖。编辑已保留，先处理原运行或确认启动结果。','This plan is running or its start is unresolved. Edits are retained; resolve the original run first.');renderDrawer();return;}
  if(check&&!nativeEditor()&&lock()){renderDrawer();return;}
  if(!nativeEditor())mode='signal';
  if(!['auto','signal'].includes(mode)){feedback=L('请选择执行方式。','Choose an execution mode.');renderDrawer();return;}
  if(nativeEditor()&&amount===''&&resolvedAmount<MIN_ORDER_USDT){const minimum=botRequiredCapital({...nativePlan(),amount:MIN_ORDER_USDT});feedback=Number.isFinite(minimum)?L('按当前买入安排，总金额至少需要 '+amountFormat(minimum)+' USDT（含手续费）。提高总金额或调整参数。','These entries need at least '+amountFormat(minimum)+' USDT including fees. Increase allocation or adjust the entries.'):L('请先等待行情建议参数就绪，或补齐手动参数。','Wait for market-based parameters, or complete the manual parameters.');renderDrawer();return;}
  if(!Number.isFinite(resolvedAmount)||resolvedAmount<MIN_ORDER_USDT||resolvedAmount>1000||!Number.isFinite(cap)||cap<resolvedAmount||cap>w.s.risk.cap){feedback=L('单笔至少 '+MIN_ORDER_USDT+'，不能超过策略总金额或账户上限。','An entry must be at least '+MIN_ORDER_USDT+' and within the strategy and account limits.');renderDrawer();return;}
  if(!Number.isSafeInteger(researchBudget)||researchBudget<0||researchBudget>10000){feedback=L('研究积分上限请填写 0–10,000 的整数。','Enter a whole-number research limit from 0 to 10,000.');renderDrawer();return;}
  if(check&&desk.access&&!routeAccess().ready){feedback=accessMessage(routeAccess());renderDrawer();return;}
  if(check&&contextError(w.s.setupContext)){feedback=L('请先选择可执行的账户。','Select an account that supports this strategy.');renderDrawer();return;}
  if(check&&nativeEditor()){
   try{checkedParameterQuote=currentBotQuote();const {market,profileId,venueId,period,closedPrice,closedAt,asOf}=checkedParameterQuote;simulationReference={market,profileId,venueId,period,closedPrice,closedAt,asOf};}catch{checkedParameterQuote=null;simulationReference=null;}
   const issue=botRecommendationIssue(nativePlan(),parameterReference,checkedParameterQuote);
   if(issue){feedback=quoteMessage(issue);renderDrawer();return;}
  }
  const intent={...(nativeEditor()?{planVariant:context.variant,botParameters:nativePlan().botParameters,simulationReference:simulationReference||undefined}:{}),amount:resolvedAmount,cap,mode,protection:JSON.parse(JSON.stringify(protection)),market:executionRoute.market,executionRoute:{...executionRoute}},variant=context.variant,scope=JSON.stringify([w.s.setupContext,w.account?.scope]);
  const liveAccount=liveBinanceSpotRoute(intent.executionRoute,intent.market),walletAccount=liveWalletSpotRoute(intent.executionRoute,intent.market);
  if(nativeEditor()){const issue=editorPlanError({...nativePlan(),...intent});if(issue){feedback=issue;renderDrawer();return;}if(check&&!liveAccount&&!walletAccount){const issue=desk.botCreateError?.({...nativePlan(),...intent});if(issue){feedback=issue;renderDrawer();return;}}}
  const saved=context.draftId?w.draft(context.draftId):null,reuse=Boolean(check&&saved&&w.s.selectedDraftId===saved.id&&w.setupReady&&saved.amount===resolvedAmount&&saved.cap===cap&&saved.mode===mode);
  if(check&&!nativeEditor()&&!reuse&&w.quote(20)>0&&(w.available<w.quote(20)||w.todayUsage+w.quote(20)>researchBudget)){feedback=L('可用积分或今天的预算不足。可以先保存，之后再检查。','Credits or today’s budget are insufficient. Save now and check later.');renderDrawer();return;}
  const budgetError=nativeEditor()?null:await w.setBudget({byok:w.account?w.account.s.preferences.byok:w.s.budget.byok,daily:researchBudget});
  if(opened!==context)return;
  if(budgetError){feedback=budgetError;renderDrawer();return;}
  let d=context.draftId?w.draft(context.draftId):null;
  const liveRecord=!check&&(liveAccount||walletAccount);
  if(!d){d=await w.createManagedDraft(context.id);if(!d&&liveRecord&&/已达保存上限|saved-item limit/.test(String(w.draftSaveError||''))){w.draftSaveError='';d=w.createDraft(context.id);}if(!d)throw Error(w.draftSaveError||L('草稿未能保存，输入已保留。请检查账户状态后重试。','Could not save this draft. Your inputs are retained. Check account access and try again.'));}
  if(!liveRecord){const entitlementError=await w.ensureDraftEntitlement(d);if(entitlementError){if(opened===context){feedback=entitlementError;renderDrawer();}else notify(entitlementError,{tone:'error'});return;}}
  const priorVersion=d.version,variantChanged=(d.planVariant||'baseline')!==variant;
  const error=w.saveDraft(d.id,intent);
  if(!error){
   if(variantChanged){if(d.version===priorVersion)d.version++;d.validatedVersion=null;d.status='draft';}
   d.planVariant=variant;d.combination=intent.protection.id==='astarter';if(context.source)d.researchSource={...context.source};context.draftId=d.id;
   const buffer=w.s.botEditors?.[context.editorKey||context.id];
   if(buffer&&(!buffer.draftId||buffer.draftId===d.id))saveBotEditor(w,{...buffer,draftId:d.id,baseVersion:d.version},context.editorKey||context.id);
   if(opened===context)remember();else w.touch();
  }
  if(error){if(opened===context){feedback=error;renderDrawer();}else notify(error,{tone:'error'});return;}
  if(d.executionRoute?.connectionId!==intent.executionRoute.connectionId)throw Error(L('接入绑定未保存，暂不能检查或启动。输入已保留。','The connection binding was not saved. Checking and starting are blocked; your inputs are retained.'));
  if(opened!==context){refresh();notify(L('设置已保存，未启动交易。','Settings saved. Trading has not started.'),{tone:'success'});return;}
  acceptEditor();
  if(!check||liveBinanceSpotRoute(intent.executionRoute,intent.market)||liveWalletSpotRoute(intent.executionRoute,intent.market)){let message=liveBinanceSpotRoute(intent.executionRoute,intent.market)?L('方案已保存在已核对的币安现货账户上。这一步不发单。','Saved on the checked Binance spot account. This step does not send an order.'):liveWalletSpotRoute(intent.executionRoute,intent.market)?L('方案已保存在当前钱包名下。','Plan saved for this wallet.'):L('设置已保存，未扣积分。','Settings saved. No credits used.');if(!check&&!(await writePlanMemory(intent,d,context)))message=L('方案已保存，记忆未写入','Plan saved. Memory was not written.');if(inlineHost){feedback=message;feedbackTone='success';}else{returnToCaller=null;drawer.close();refresh();notify(message,{tone:'success',action:()=>route('execution'),actionLabel:L('查看我的交易','View my trading')});}return;}
  if(scope!==JSON.stringify([w.s.setupContext,w.account?.scope])||intent.cap>w.s.risk.cap||!nativeEditor()&&lock()){feedback=L('账户或保护设置已变化，请重新确认。','The account or protection settings changed. Review them again.');renderDrawer();return;}
  if(nativeEditor()){
   const sourceIssue=recommendationIssue(context.source);if(sourceIssue){feedback=sourceIssue;renderDrawer();return;}
   try{checkedParameterQuote=currentBotQuote();}catch{checkedParameterQuote=null;}
   const issue=botRecommendationIssue(nativePlan(),parameterReference,checkedParameterQuote);
   if(issue){feedback=quoteMessage(issue);renderDrawer();return;}
  }
  w.s.preferredExecutionMode=intent.mode;w.touch();
  if(w.setupReady){phase='check';feedback='';renderDrawer();return true;}
  const result=w.validateSetup(strategyAccessOptions(intent.executionRoute,intent.mode));if(result.error){feedback=result.error;renderDrawer();return;}phase='check';feedback='';renderDrawer();return true;
 }
 async function submitSettings(kind){
  if(submission)return;
  const form=drawer.querySelector('#sc-config'),localOnly=['save','save-research'].includes(kind)&&(!executionRoute.connectionId||!executionRoute.accountId||!executionRoute.market);
  // Reveal invalid fields before the pending state makes the form inert.
  if(form&&!localOnly&&!form.reportValidity())return;
  const context=opened;feedback='';feedbackTone='error';submission=context;paintSubmission();
  try{
   if(kind==='save-research'){
    capture();if(drawer.querySelector('#sc-config')){await save(false,context);if(opened!==context||!context.draftId||feedbackTone==='error'&&feedback)return;}
    const prior=context.draftId?w.draft(context.draftId):null,variant=context.variant;
    if(prior&&(activeId()===prior.id||['requested','unknown'].includes(prior.botLaunch?.status)))throw Error(L('先处理原运行，再保存新研究版本。','Resolve the original run before saving another research version.'));
    const d=prior||await w.createManagedDraft(context.id);if(!d)throw Error(w.draftSaveError||L('草稿未能保存，输入已保留。请检查账户状态后重试。','Could not save this draft. Your inputs are retained. Check account access and try again.'));
    const error=await w.ensureDraftEntitlement(d);if(error)throw Error(error);
    if((d.planVariant||'baseline')!==variant||d.mode!=='signal'){d.version++;d.validatedVersion=null;}d.planVariant=variant;d.contractVersion=strategyPlan(context.id,variant).record.version;d.mode='signal';d.status='research';context.draftId=d.id;w.s.selectedDraftId=d.id;remember();w.touch();
    if(opened===context)acceptEditor();
    if(opened===context&&inlineHost){feedback=L('研究方案已保存，未启动交易。','Research plan saved. Trading has not started.');feedbackTone='success';return;}if(opened===context){returnToCaller=null;drawer.close();}refresh();notify(L('研究方案已保存，未启动交易。','Research plan saved. Trading has not started.'),{tone:'success',action:()=>route('execution'),actionLabel:L('查看我的交易','View my trading')});return;
   }
   await save(kind!=='save',context);
   // Checking stops at the approval screen; only the explicit launch action starts watching.
  }catch(error){if(opened===context){feedback=error.message||L('保存未完成，请重试。','Could not save. Try again.');feedbackTone='error';renderDrawer();}else notify(error.message,{tone:'error'});}
  finally{if(submission===context){submission=null;if(opened===context&&nativeEditor()&&phase==='configure'&&['start','check'].includes(kind)){invalidateCheck(context.draftId);remember();}if(opened===context&&drawer.open)renderDrawer();}}
 }
 async function action(el){const a=el.dataset.sc,id=el.dataset.id;if(submission&&submission===opened&&a!=='close')return;
  if(a==='edit-local'){
   const raw=loadBotEditors(w)[id],editor=raw&&readBotEditor(w,raw.id,null,id);
   if(!localDraftInScope(editor)){notify(L('这份本机草稿暂不可用，请返回重新选择。','This local draft is unavailable. Return and choose it again.'),{tone:'error'});return;}
   open(editor.id,null,true,{editorKey:id,source:editor.source||null});return;
  }

  if(a==='bot-end'){endRunId=id;refresh();return;}
  if(a==='bot-end-cancel'){endRunId=null;refresh();return;}
  if(a==='bot-reuse'){
   const run=desk.readSnapshot()?.botBook?.runs?.find(run=>run.id===id);if(!run)return;
   open(run.plan.strategy,null,true,{fresh:true,editorKey:run.plan.strategy+':new:'+Date.now()});
   executionRoute={...run.plan.executionRoute,market:run.plan.market};amount=run.plan.amount;cap=run.plan.cap;mode='auto';protection=structuredClone(run.plan.protection);botParameters={...run.plan.botParameters};parameterSource='manual';parameterReference=null;phase='configure';remember();renderDrawer();return;
  }
  if(a==='bot-action'){
   const run=desk.readSnapshot()?.botBook?.runs?.find(run=>run.id===id),kind=el.dataset.kind;
   if(!run||String(run.plan.version)!==el.dataset.version||run.plan.executionRoute.accountId!==el.dataset.account||run.plan.executionRoute.connectionId!==el.dataset.connection){notify(L('运行或账户已变化，请重新打开运行后再操作。','Run or account changed. Reopen the run before acting.'),{tone:'error'});return;}
   el.disabled=true;let error;try{error=await desk.botAction(id,kind,{requestId:id+':'+kind+':'+crypto.randomUUID(),expectedAccountId:el.dataset.account,expectedConnectionId:el.dataset.connection,expectedEnvironment:'DEMO',...(el.dataset.order?{orderId:el.dataset.order}:{})});}catch(cause){error=cause.message||L('结果尚未确认，请查询原订单。','The result is unconfirmed. Check the original order.');}
   const pendingEnd=error?.pending===true;
   if(!error||pendingEnd)endRunId=null;refresh();
   const updated=desk.readSnapshot()?.botBook?.runs?.find(row=>row.id===id),result=kind==='query'?L('查询已记录，原订单未重发。','Query recorded. The original order was not resubmitted.'):updated?botInstanceStatus(updated.status):L('BOT 状态已更新。','BOT status updated.');
   notify(pendingEnd?error.message:error||`${run.id} · ${run.plan.market} · ${result}`,{tone:pendingEnd?'info':error?'error':'success'});return;
  }
  if(a==='resume-editor'){
   const pending=pendingEditor;if(!pending)return;
   if(pending.draftId&&!w.draft(pending.draftId)){feedback=L('原草稿已不可用，未应用接入。','The original draft is unavailable. The connection was not applied.');renderDrawer();return;}
   open(pending.id,pending.draftId,true,{editorKey:pending.key,source:pending.sourceHint,onReturn:returnToCaller});return;
  }
  if(a==='new-editor'){
   const pending=pendingEditor;if(!pending){const current=opened;open(current.id,null,true,{fresh:true,editorKey:current.id+':new:'+Date.now(),source:current.source,onReturn:returnToCaller,defaultProtection:current.defaultProtection});return;}
   const previousKey=pending.key+':previous';
   if(!saveBotEditor(w,pending.editor,previousKey)){feedback=L('保存未完成，请重试。','Could not save. Try again.');renderDrawer();return;}
   open(pending.id,null,true,{editorKey:pending.key,source:pending.sourceHint,fresh:true,previousEditorKey:previousKey,onReturn:returnToCaller,defaultProtection:pending.defaultProtection});return;
  }
  if(a==='restore-previous'){
   const key=opened?.previousEditorKey,record=key?loadBotEditors(w)[key]:null,d=record?.draftId?w.draft(record.draftId):null;
   if(!record||!readBotEditor(w,record.id,d,key)){feedback=L('原草稿版本已变化，未应用返回的接入。','The draft version changed. The returned connection was not applied.');renderDrawer();return;}
   open(record.id,record.draftId,true,{editorKey:key,source:workspaceSource,onReturn:returnToCaller});return;
  }
  if(a==='return-source'){return requestExit(()=>drawer.close());}


  if(a==='workspace-select'){
   if(id===workspaceSelection&&drawer.open)return;
   if(id.startsWith('research:'))return action({dataset:{sc:'suggestion',id:id.slice(9)}});
   if(id.startsWith('product:')){const item=BOT_PRODUCT_CAPABILITIES.find(p=>p.id===id.slice(8)&&!p.family);if(!item)return;capture();remember();placeEditor(workspaceHost(root));workspaceSelection=id;opened=null;executionRoute=null;feedback='';renderCapability(item);refresh();return;}
   if(strategyById(id)){openTemplate(id,returnToCaller,workspaceSource);refresh();}return;
  }
  if(a==='choose-instrument'){chooseInstrument();return;}

  if(a==='query-start'){
   const context=opened,draft=w.draft(context.draftId);submission=context;paintSubmission();
   try{const error=await desk.recoverBotLaunch?.(draft?.botLaunch?.requestId);if(opened!==context)return;if(error){draft.botLaunch.status='unsent';w.touch();feedback=error;phase='configure';}else{feedback=reconcileStrategyWatch(w,desk,draft)||'';if(!feedback)phase=['stopped','interrupted','failed'].includes(draft.botLaunch.status)?'ended':'success';}}
   catch(error){if(opened===context)feedback=error.message||L('结果尚未确认，请查询原订单。','The result is unconfirmed. Check the original order.');}
   finally{if(submission===context)submission=null;if(opened===context&&drawer.open)renderDrawer();}return;
  }
  if(a==='mobile-view'){capture();mobileView=id==='market'?'market':'settings';renderDrawer();const body=editorScrollElement();if(body)body.scrollTop=viewScroll[mobileView]||0;remember();return;}
  if(a==='route-connect'){
   capture();remember();const current=opened,back=returnToCaller,page=document.body.dataset.page,route={...executionRoute},version=current.draftId?w.draft(current.draftId)?.version:0,context={route:'bot',draftId:current.draftId||'editor:'+current.id,version};
   const scope=()=>JSON.stringify([w.account?.scope||'local',w.s.setupContext?.accountId,w.s.setupContext?.environment]),originalScope=scope(),token={applied:false};let issue='';
   settingsReturn=token;returnToCaller=null;drawer.close();
   const same=()=>settingsReturn===token&&document.body.dataset.page===page&&scope()===originalScope;
   desk.settings?.(route.profileId.startsWith('cex')?'exchange':'wallet',{connectionId:route.connectionId||undefined,service:route.profileId.startsWith('cex')?route.venueId:undefined,chain:route.chainId,returnContext:context,
    onReturn(selection){
     if(token.applied)return;
     const original=current.draftId?w.draft(current.draftId):null,returned=selection?.context,editor=readBotEditor(w,current.id,original,current.editorKey||current.id);
     if(!same()||returned?.route!==context.route||returned.draftId!==context.draftId||returned.version!==version||current.draftId&&original?.version!==version||!editor){issue=L('原草稿或账户已变化，未应用返回的接入。请重新选择。','The original draft or account changed. The returned connection was not applied; choose it again.');return;}
     const bound=bindStrategyConnection(editor.executionRoute,selection.connectionId,desk.snapshot()?.connections);
     if(!bound){issue=L('接入的平台、市场或网络与草稿不一致，未更换账户。','The connection venue, product or network does not match the draft. The account was not changed.');return;}
     invalidateCheck(current.draftId);saveBotEditor(w,{...editor,executionRoute:bound},current.editorKey||current.id);token.applied=true;
    },
    onClose(){
     if(!same()){if(settingsReturn===token)settingsReturn=null;return;}
     if(current.draftId&&!w.draft(current.draftId)){settingsReturn=null;notify(L('原草稿已不可用，未应用接入。','The original draft is unavailable. The connection was not applied.'),{tone:'error'});return;}
     if(current.draftId&&w.draft(current.draftId).version!==version)issue=L('原草稿版本已变化，未应用返回的接入。','The draft version changed. The returned connection was not applied.');
     open(current.id,current.draftId,true,{editorKey:current.editorKey,source:current.source?.id?current.source:null,previousEditorKey:current.previousEditorKey,onReturn:back});returnToCaller=back;if(issue){feedback=issue;feedbackTone='error';renderDrawer();}
    }});return;
  }
  if(a==='parameter-source'){capture();parameterSource=id==='manual'?'manual':'recommended';remember();renderDrawer();return;}
  if(a==='apply-bot-parameters'){capture();try{liveParameterQuote=currentBotQuote();applyBotQuote(liveParameterQuote);}catch{feedback=quoteMessage('MARKET_NOT_READY');renderDrawer();}return;}
  if(a==='config-view'){capture();configView=id==='full'?'full':'quick';renderDrawer();if(configView==='full'){drawer.querySelector('.sc-config-advanced').open=true;drawer.querySelector('.sc-protection-settings').open=true;}return;}
  if(a==='allocation'){if(![.25,.5,.75,1].includes(Number(id)))return;capture();const liveSpot=spendableSpotUsdt(desk.snapshot()?.connections,executionRoute,w.s.risk.cap)!==null||spendableWalletUsdt(desk.snapshot()?.connections,executionRoute,w.s.risk.cap)!==null;if(!liveSpot&&(!strategyRouteReady(executionRoute,opened?.variant)||!strategyRouteConnected(executionRoute,desk.snapshot()?.connections,routeAccess())))return;const snapshot=desk.snapshot(),limit=nativeEditor()?nativeAvailable():Math.min(Math.max(0,w.s.risk.cap-Number(snapshot.botSummary?.allocated||0)),Number(snapshot.cash??0));if(limit===null||limit<MIN_ORDER_USDT)return;cap=Math.max(MIN_ORDER_USDT,Math.floor(limit*Number(id)));if(amount!=='')amount=Math.min(Number(amount),cap);feedback='';remember();renderDrawer();return;}

  if(a==='evidence'){w.selectOpportunity(id);returnToCaller=null;drawer.close();route('workbench');return;}
  if(a==='suggestion'){const suggestion=strategySuggestions(w).find(item=>item.symbol===id);if(!suggestion)return;openTemplate(suggestion.strategy,null,{type:'research',id:suggestion.id||id,revision:suggestion.revision,instrument:{symbol:id},reason:suggestion.reason});if(inlineHost)workspaceSelection='research:'+id;renderDrawer();refresh();return;}
  if(a==='plan-tab'){if(['plan','parameters','abc'].includes(id)){planTab=id;renderDrawer();}return;}
  if(a==='scenario'){if(['A','B','C'].includes(id)){planScenario=id;renderDrawer();}return;}
  if(a==='view-list'){returnToCaller=null;route('execution');return;}
  if(a==='navigate'){return requestExit(()=>{const runId=id==='execution'&&opened?.draftId?w.draft(opened.draftId)?.botLaunch?.runId:null;returnToCaller=null;drawer.close();route(id,runId?{runId}:undefined);});}
  if(a==='use'){open(id);if(strategyPlan(id).flowAvailable)phase='configure';renderDrawer();return;}
  if(a==='open'){open(id);return;}
  if(a==='open-editor'){
   const raw=loadBotEditors(w)[id];
   if(!raw?.id||!strategyById(raw.id)){notify(L('这份方案已变化，请返回重新选择。','This plan changed. Return and choose it again.'),{tone:'error'});return;}
   const linked=raw.draftId?w.draft(raw.draftId):null;
   const saved=readBotEditor(w,raw.id,linked&&linked.strategy===raw.id?linked:null,id);
   open(raw.id,saved?.draftId||null,true,{editorKey:id,source:(saved||raw).source||null});
   if(!saved&&opened?.editorKey===id){cap=raw.cap??'';amount=raw.amount??'';if(raw.executionRoute)executionRoute={...executionRoute,...raw.executionRoute};if(raw.botParameters)botParameters={...botParameters,...raw.botParameters};phase='configure';renderDrawer();}
   return;
  }
  if(a==='draft'){const d=w.draft(id);if(!d)return;open(d.strategy,id);if(d.status==='validating'&&strategyFlowAvailable(d)){phase='check';renderDrawer();}return;}
  if(a==='close'){if(inlineHost&&phase==='stop'){phase='configure';renderDrawer();return;}return requestExit(()=>{if(inlineHost){returnToCaller=null;drawer.close();route('execution');}else drawer.close();});}
  if(a==='overview'&&inlineHost){capture();remember();const detail=drawer.querySelector('.sw-plan-section');detail?.focus({preventScroll:true});detail?.scrollIntoView?.({block:'start'});return;}if(a==='overview'||a==='protection'){capture();remember();phase=a==='protection'&&strategyPlan(opened.id,opened.variant).flowAvailable?'configure':'overview';feedback='';renderDrawer();return;}if(a==='policy'){capture();protection=protectionConfig(id,protection.mode,id==='astarter'?protection.parameters:undefined);remember();renderDrawer();return;}if(a==='risk-mode'){capture();protection=protectionConfig('astarter',id,protection.parameters);remember();renderDrawer();return;}if(a==='risk-scene'){capture();riskScene=id;renderDrawer();return;}if(a==='configure'){phase='configure';feedback='';renderDrawer();return;}
  if(a==='save-plan')return submitSettings('save');
  if(a==='resolve-access'){return action({dataset:{sc:'route-connect'}});}if(a==='save'||a==='check')return submitSettings(a);
  if(a==='start'&&executionRoute.accountId==='SIM-01')return submitSettings(a);
  if(a==='save-research')return submitSettings(a);
  if(a==='cancel'){feedbackTone='info';w.cancelValidation(w.draft(opened.draftId)?.validationId);feedback=w.account?L('已取消检查，未扣积分。','Check cancelled. No credits charged.'):L('已取消，暂占积分已退回。','Cancelled. Reserved credits released.');phase='configure';renderDrawer();return;}
  if(a==='launch'){
   feedbackTone='error';
   if(!nativeEditor()){feedback=L('该版本仅可保存研究方案，尚未开放创建模拟。','This version is available for research only. Simulation creation is not enabled.');phase='configure';renderDrawer();return;}
   if(phase!=='check')return;
   const sourceIssue=recommendationIssue()||(opened.source?.recommendationId!==w.draft(opened.draftId)?.researchSource?.recommendationId?L('方案来源已变化，请重新检查，编辑已保留。','The plan source changed. Your edits are retained; check again.'):null);if(sourceIssue){invalidateCheck();feedback=sourceIssue;phase='configure';remember();renderDrawer();return;}
   if(!simulationReference||JSON.stringify(simulationReference)!==JSON.stringify(w.draft(opened.draftId)?.simulationReference)){invalidateCheck();feedback=L('模拟参考价尚未确认，请重新检查方案。','The simulation reference is unconfirmed. Check the plan again.');phase='configure';renderDrawer();return;}
   const quoteIssue=botRecommendationIssue(nativePlan(),parameterReference,checkedParameterQuote);
   if(quoteIssue){invalidateCheck();feedback=quoteMessage(quoteIssue);phase='configure';renderDrawer();return;}
   if(w.s.selectedDraftId!==opened.draftId){feedback=L('当前策略已变化，请重新检查。','The selected strategy changed. Check it again.');renderDrawer();return;}
   const context=opened;submission=context;paintSubmission();
   try{const error=await startStrategyWatch(w,desk,onResearchStart);if(opened!==context)return;if(error){feedback=error;if(w.draft(context.draftId)?.botLaunch?.status==='unknown')phase='unknown';return;}
    phase=['stopped','interrupted','failed'].includes(w.draft(context.draftId)?.botLaunch?.status)?'ended':'success';feedback='';
   }finally{if(submission===context)submission=null;if(opened===context&&drawer.open)renderDrawer();}return;
  }
  if(a==='stop'){const d=w.draft(id);if(!d)return;open(d.strategy,id);phase='stop';renderDrawer();return;}
  if(a==='trade'||a==='confirm-stop'){const sync=desk.syncStatus();if(sync.state!=='LIVE'||sync.scope.accountId!=='SIM-01'||sync.scope.environment!=='DEMO'){notify(L('请先恢复模拟账户的读取。','Restore the demo account feed first.'));return;}const error=desk.action(a==='confirm-stop'?'stop':id);if(error){notify(error);return;}if(drawer.open)drawer.close();refresh();return;}
  if(a==='disarm'){const sync=desk.syncStatus();if(sync.state!=='LIVE'||sync.scope.accountId!=='SIM-01'||sync.scope.environment!=='DEMO'){notify(L('请先恢复模拟账户的读取。','Restore the demo account feed first.'));return;}const error=desk.action('pause');if(error){notify(error);return;}w.s.strategyCenterArmedDraftId=null;w.touch();refresh();return;}
  if(a==='catalog-view'){catalogView=['capabilities','recommendations'].includes(id)?id:'templates';group='all';compareOnly=false;productFilter='';refresh();return;}
  if(a==='market-filters'){marketFiltersOpen=!marketFiltersOpen;refresh();return;}
  if(a==='market-scope'){marketScope=['spot','chain','derivatives'].includes(id)?id:'all';refresh();return;}
  if(a==='market-product'){const item=BOT_PRODUCT_CAPABILITIES.find(p=>p.id===id);if(!item)return;return action({dataset:{sc:'workspace-select',id:item.family||'product:'+id}});}
  if(a==='compare-candidates'){compareOnly=!compareOnly;refresh();return;}
  if(a==='save-candidate'){if(!BOT_PRODUCT_CAPABILITIES.some(item=>item.id===id&&!item.family))return;w.s.botCatalogSelections=[...new Set([...(w.s.botCatalogSelections||[]),id])];w.touch();refresh();return;}
  if(a==='open-variant'){const [family,variant]=id.split(':');if(!strategyVariants(family).some(v=>v.id===variant))return;open(family);opened.variant=variant;phase='overview';renderDrawer();return;}
  if(a==='group'){group=id;catalogView='templates';productFilter='';refresh();}if(a==='mine-filter'){mineFilter=id;refresh();}if(a==='clear'){catalogView='templates';compareOnly=false;group='all';query='';onlyReady=false;marketScope='all';marketTime='all';marketSort='default';marketFiltersOpen=false;refresh();}
 }
 drawer.addEventListener('cancel',event=>{event.preventDefault();requestExit(()=>drawer.close());});
 drawer.addEventListener('change',event=>{
  const key=event.target.dataset?.strategyRoute;if(!opened||!['connectionId','profileId','venueId','chainId','market'].includes(key))return;capture();let next={...executionRoute,[key]:event.target.value};
  if(key==='connectionId'){const record=tradingConnections(desk.snapshot()?.connections).find(item=>item.id===event.target.value);next=event.target.value?signedWalletRoute(record,executionRoute.market)||signedExchangeRoute(record,executionRoute.market)||bindStrategyConnection(executionRoute,event.target.value,desk.snapshot()?.connections):{...executionRoute,connectionId:'',accountId:''};if(!next){feedback=L('原交易接入不可用或与方案不一致，请重新选择。','The bound connection is unavailable or does not match this plan. Choose it again.');feedbackTone='error';renderDrawer();return;}}
  if(key==='profileId'){const bscSpot=next.profileId==='dex-spot'&&!String(opened.id).startsWith('S09'),walletReady=bscSpot&&tradingConnections(desk.snapshot()?.connections).some(record=>record.id==='wallet-bsc'&&record.status==='connected'&&record.chain==='56');if(!strategyMarkets(opened.id).includes(next.profileId)&&!(walletReady&&!strategyMarkets(opened.id).includes('dex-spot')))return;next.venueId=bscSpot?'pancakeswap':strategyVenues(next.profileId)[0].id;next.chainId=!next.profileId.startsWith('dex')?'':String(opened.id).startsWith('S09')?'1':bscSpot?'56':'1';next.market='';next.accountId='';next.connectionId='';}
  if(['venueId','chainId'].includes(key)){if(key==='chainId'&&next.chainId==='56'&&next.profileId==='dex-spot')next.venueId='pancakeswap';next.accountId='';next.connectionId='';}
  applyExecutionRoute(next);
 });
 drawer.addEventListener('click',ev=>{const b=ev.target.closest('[data-sc]');if(b&&(b.type!=='submit'||!b.form))return action(b);});drawer.addEventListener('input',event=>{if(feedback){feedback='';const note=drawer.querySelector('.sc-feedback');if(note){note.textContent='';note.setAttribute('role','status');}}capture(event);});drawer.addEventListener('submit',ev=>{ev.preventDefault();return action({dataset:{sc:ev.submitter?.dataset.sc||'start'}});});drawer.addEventListener('close',()=>{if(drawer.open)return;if(instrumentDialog?.open)instrumentDialog.close();if(editExitDialog?.open)editExitDialog.close();if(!opened?.exitDiscarded){capture();remember();}disposeBotCharts();visitedEditors.clear();pendingEditor=null;workspaceSource=null;opened=null;feedback='';const returnTo=returnToCaller;returnToCaller=null;if(returnTo){returnTo();return;}if(opener?.isConnected&&!opener.closest?.('dialog:not([open])'))opener.focus?.();else (root.querySelector('.sig-event.selected [data-track-open]')||root.querySelector('[data-sc="navigate"][data-id="my-strategies"]')||root.querySelector('h1'))?.focus();});
 document.addEventListener('hive:access',()=>{if(drawer.open){capture();feedback='';renderDrawer();}});
 document.addEventListener('hive:locale',()=>{if(drawer.open){capture();renderDrawer();}});
 return {beforeLeave,nativeTrading,instancesView(data,history=false){const scope=desk.syncStatus?.().scope;if(scope&&(scope.accountId!=='SIM-01'||scope.environment!=='DEMO'))return '';if(data?.botSummary?.recoveryError)return '<p role="alert">'+e(data.botSummary.recoveryError)+'</p>';return botInstancesView(data,nativeNames(),{history,endRunId});},nativeInstances(){const data=desk.readSnapshot();if(data?.botSummary?.recoveryError)return '<p role="alert">'+e(data.botSummary.recoveryError)+'</p>';return data?.botBook?.runs?.length?mineToolbar()+(mineFilter==='history'?botHistoryView(data,nativeNames()):mineFilter==='saved'?'':botInstancesView(data,nativeNames(),{endRunId})):'';},savedPlans(){return ['all','saved'].includes(mineFilter)?mine(true):'';},render(page){if(page!=='strategies'&&inlineHost){capture();remember();disposeBotCharts();placeEditor(null);}return page==='strategies'?catalog():page==='my-strategies'?mine():null;},recommendations:()=>strategyRecommendations(w,desk.snapshot()),chooseRecommendation,openTemplate,prepareDraft(id){const d=w.draft(id);if(!d)return false;open(d.strategy,id,true);return true;},openDraft(id,chooseProtection=false,executionMode){const d=w.draft(id);if(d){open(d.strategy,id);if(['auto','review','signal'].includes(executionMode)&&strategyFlowAvailable(d)){mode=executionMode;phase='configure';renderDrawer();}if(chooseProtection&&strategyFlowAvailable(d)){phase='configure';renderDrawer();const panel=drawer.querySelector('.sc-protection-settings');if(panel){panel.open=true;panel.querySelector('summary')?.focus({preventScroll:false});}}}},bind(container=root){
 const host=workspaceHost(container);
 if(host){
  placeEditor(host);
  if(!settingsReturn&&!openingPage){
   const params=new URLSearchParams(globalThis.location?.search||''),requested=params.get('create'),key=params.get('editor')||requested;
   if(openPage&&strategyById(requested)){
    const saved=key&&loadBotEditors(w)[key];
    if(key.length>4096||key!==requested&&!key.startsWith(requested+':')||key!==requested&&(!saved||saved.id!==requested||!readBotEditor(w,requested,saved.draftId?w.draft(saved.draftId):null,key))){notify(L('配置链接已失效，请重新选择 Agent。','This setup link expired. Choose an Agent again.'),{tone:'error'});route('strategies',{replace:true});return;}
    if(!opened||opened.id!==requested||opened.editorKey!==key)open(requested,null,true,{editorKey:key});
   }else if(!opened){if(workspaceSelection.startsWith('product:'))renderDrawer();else open(workspaceSelection);}
   if(!drawer.open){drawer.show();disposeBotCharts=mountBotCharts();}
  }
 }else if(inlineHost){capture();remember();disposeBotCharts();placeEditor(null);}
 artObserver.disconnect();observeArt(container);if(drawer.open)observeArt(drawer);
 container.querySelectorAll('[data-combo]').forEach(el=>el.ontoggle=()=>{if(!el.isConnected)return;if(el.open)expandedDrafts.add(el.dataset.combo);else expandedDrafts.delete(el.dataset.combo);});
 container.querySelectorAll('[data-sc]').forEach(b=>{if(!drawer.contains?.(b))b.onclick=()=>action(b);});
 const input=container.querySelector('#sc-search');if(input)input.oninput=()=>{query=input.value;const at=input.selectionStart;refresh();const next=root.querySelector('#sc-search');next?.focus();next?.setSelectionRange(at,at);};
 const ready=container.querySelector('#sc-ready');if(ready)ready.onchange=()=>{onlyReady=ready.checked;refresh();};
 
 const selectionList=container.querySelector('.sw-strategy-list');
 if(selectionList)selectionList.onkeydown=async event=>{
  if(submission||!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  const current=event.target.closest('.sw-strategy'),buttons=[...selectionList.querySelectorAll('.sw-strategy:not(:disabled)')],index=buttons.indexOf(current);if(index<0||!buttons.length)return;
  event.preventDefault();const target=buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length],id=target.dataset.id;
  await action(target);const next=[...root.querySelectorAll('.sw-strategy')].find(button=>button.dataset.id===id);next?.focus({preventScroll:true});next?.scrollIntoView?.({block:'nearest'});
 };

 const choice=container.querySelector('#sw-strategy-choice');if(choice)choice.onchange=()=>action({dataset:{sc:'workspace-select',id:choice.value}});
 for(const [id,apply]of [['mp-scope',v=>marketScope=v],['mp-time',v=>marketTime=v],['mp-sort',v=>marketSort=v],['mp-group',v=>{catalogView=['capabilities','recommendations'].includes(v)?v:'templates';group=catalogView==='templates'?v:'all';compareOnly=false;productFilter='';}]]){const field=container.querySelector('#'+id);if(field)field.onchange=()=>{apply(field.value);refresh();};}
},tick(dt){age+=dt;if(age<.4)return;age=0;if(drawer.open&&phase==='check'){const d=w.draft(opened?.draftId),v=w.s.validations.find(v=>v.id===d?.validationId),next=JSON.stringify([v?.status,w.available,Boolean(w.setupReady),w.s.selectedDraftId,w.s.risk.version]);if(stamp!==next){stamp=next;renderDrawer();}else{drawer.querySelectorAll('.sc-checklist li').forEach((li,i)=>{const done=v?.progress>=(i+1)*25;li.querySelector('i').textContent=done?'✓':'·';li.querySelector('span').textContent=done?L('已检查','Checked'):L('等待','Pending');});}}else if(!drawer.open&&!settingsReturn&&['execution','strategies','my-strategies','validation'].includes(document.body.dataset.page)&&canAutoRefresh(root)){const s=desk.snapshot(),next=JSON.stringify([w.available,w.s.drafts.map(d=>[d.id,d.version,d.status,d.riskVersion]),w.s.risk.version,s.discovery?.armed,s.state,s.session?.draftId,s.botSummary?.revision,w.research?.tasks.map(task=>[task.symbol,task.version,task.phase]),document.body.dataset.page==='strategies'?strategyRecommendations(w,s).map(row=>[row.id,row.status,row.canAdopt,row.freshness]):null]);if(stamp!==next){stamp=next;refresh();}}}};
}
