import test from 'node:test';
import assert from 'node:assert/strict';
import {MultiResearch} from './multi-research.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import * as targets from './workbench-targets.mjs';

test('shared asset focus narrows opportunities while the multi-asset Agent library stays complete',()=>{
 const research=new MultiResearch(),w=new WorkspaceSim({research});
 const rows=['BTC','ETH'].map(asset=>({id:'focus-'+asset,strategy:'S03',asset,market:asset+'/USDT',sourceType:'research',freshness:'current',source:{instrument:{symbol:asset}}}));
 const before=JSON.stringify([w.s.drafts,w.s.trade,w.s.usage]);
 targets.setWorkbenchTargets(w,research,{focusAsset:'ETH'});
 const focused=renderBotOverview({w,trade:{botBook:{runs:[]}},recommendations:rows});
 assert.match(focused,/target-scope-bar/);assert.match(focused,/data-recommendation="focus-ETH"/);assert.doesNotMatch(focused,/data-recommendation="focus-BTC"/);
 assert.equal((focused.match(/data-bot-strategy=/g)||[]).length,18);
 targets.setWorkbenchTargets(w,research,{focusAsset:null});
 const restored=renderBotOverview({w,trade:{botBook:{runs:[]}},recommendations:rows});
 assert.equal((restored.match(/data-recommendation=/g)||[]).length,2);
 assert.equal(JSON.stringify([w.s.drafts,w.s.trade,w.s.usage]),before);
});
import {botHubSummary,filterBotRuns,botHubCards,botReturnSeries,botRunTarget,botRecommendationScope,recommendationItems,recommendationKey,mountRecommendationCarousel,renderBotOverview,renderBotAssets,createBotHub,removeLivePlan} from './bot-hub.mjs';
import {CATALOG,BOT_PRODUCT_CAPABILITIES} from './strategy-catalog.mjs';
import {executionView} from './execution-views.mjs';
import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';
import {pair} from './locale.mjs';
import {strategyRecommendations} from './strategy-advisor.mjs';

const run=(id,status,extra={})=>({id,status,plan:{strategy:'S01',market:'BTC/USDT',executionRoute:{accountId:'SIM-01',environment:'DEMO'}},allocated:100,equity:102,realizedPnl:1,unrealizedPnl:1,fees:.2,quantity:0,...extra});
test('recommended cards contain source-bound strategy plans and never fill four market placeholders',()=>{
 const base={w:{s:{}},trade:{botBook:{runs:[]}}};
 const empty=renderBotOverview(base);assert.doesNotMatch(empty,/data-market-entry=|data-bh="market-plan"/);
 const rows=['BTC','ETH','SOL'].map((asset,i)=>({id:'source-'+asset,strategy:i===1?'RX03-S':'S03',variant:'baseline',asset,market:asset+'/USDT',sourceType:'research',sourceId:asset,status:'research',canAdopt:i===1,freshness:'unknown',source:{instrument:{symbol:asset,market:asset+'/USDT'}}}));
 const before=JSON.stringify(rows),html=renderBotOverview({...base,recommendations:rows});
 assert.equal((html.match(/data-recommendation=/g)||[]).length,3);assert.doesNotMatch(html,/bh-research-lead|data-market-entry=/);
 assert.match(html,/bh-pick-plan/);assert.match(html,/入场|Entry/);assert.match(html,/退出|Exit/);assert.match(html,/2 ATR/);assert.match(html,/30m \/ 15m/);assert.match(html,/无固定止盈|no fixed target/);assert.equal(JSON.stringify(rows),before);
 const compact=html.split('data-recommendation="source-BTC"')[1].split('</article>')[0];assert.doesNotMatch(compact,/EMA20|RSI14/);const variant=renderBotOverview({...base,recommendations:[{...rows[0],variant:'E02'}]}).split('data-recommendation="source-BTC"')[1].split('</article>')[0];assert.match(variant,/EMA20|原版|baseline/);assert.doesNotMatch(variant,/无固定止盈|no fixed target/);
 const eth=html.split('data-recommendation="source-ETH"')[1].split('</article>')[0];assert.match(eth,/链上买卖力量|On-chain trade flow/);assert.match(eth,/ETH\/USDT/);
});
test('circular placement handles real variable item counts, wrapping and narrow widths',async()=>{
 const {recommendationCarouselPosition}=await import('./bot-hub.mjs');assert.equal(typeof recommendationCarouselPosition,'function');
 assert.equal(recommendationCarouselPosition(0,0,0,320),null);
 for(const total of [1,2,3,7,12])for(let active=0;active<total;active++){
  const p=recommendationCarouselPosition(active,active,total,320);assert.equal(p.x,0);assert.equal(p.y,0);assert.equal(p.scale,1);assert.equal(p.opacity,1);
  for(const width of [320,768,1084,1920])for(let i=0;i<total;i++){const q=recommendationCarouselPosition(i,active,total,width);assert.ok([q.x,q.y,q.scale,q.opacity].every(Number.isFinite));assert.ok(q.opacity>=0&&q.opacity<=1);assert.equal(q.scale,1,'every card keeps the same size throughout rotation');assert.equal(q.y,0,'rotation keeps card tops and footers aligned');}
 }
 assert.ok(recommendationCarouselPosition(6,0,7,1084).x<0);assert.ok(recommendationCarouselPosition(1,0,7,1084).x>0);
 for(const width of [768,1084,1440,1920]){const next=recommendationCarouselPosition(1,0,3,width);assert.ok(next.x-380*(1+next.scale)/2>=24,'desktop neighbors leave a readable gap');}
});
test('adding an Agent opens its creation page directly without a selection dialog',async()=>{
 const add={dataset:{bh:'create'}},selected=[],dialogs=[];
 const root={querySelectorAll:s=>s==='[data-bh]'?[add]:[],querySelector:()=>null};
 createBotHub({w:{s:{}},desk:{},root,choose:id=>selected.push(id),show:(...args)=>dialogs.push(args)}).bind();
 await add.onclick();assert.deepEqual(selected,['S01']);assert.deepEqual(dialogs,[]);
});
test('opportunity explanation maps evidence to entry and exit rules without executing or inventing a score',async t=>{
 const previous=globalThis.document,buttons=[{dataset:{bh:'recommendation-logic',id:'r1'}}],dialogs=[];
 t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 globalThis.document={querySelector:()=>({querySelectorAll:()=>[],querySelector:()=>null})};
 const row={id:'r1',strategy:'S03',variant:'baseline',asset:'BTC',market:'BTC/USDT',status:'research',canAdopt:true,executable:false,freshness:'unknown',reason:['区间仍待确认 <test>','Range awaiting confirmation <test>'],unavailableReason:['需要收盘确认','Wait for close confirmation']},before=JSON.stringify(row);
 const preview=renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}},recommendations:[row]}).split('data-recommendation="r1"')[1].split('</article>')[0];
 assert.match(preview,/BTC\/USDT/);assert.match(preview,/data-bh="recommendation-logic"/);assert.match(preview,/data-bh="recommendation"[^>]*disabled/);
 assert.doesNotMatch(preview,/bh-suggestion-state|<p>|&lt;test&gt;|<\/h3><span>/);assert.match(preview,/bh-ai-market-unconfirmed/);assert.match(preview,/市场待确认|Confirm market/);
 const root={querySelectorAll:s=>s==='[data-bh]'?buttons:[],querySelector:()=>null};
 const hub=createBotHub({w:{s:{}},desk:{},root,recommendations:()=>[row],show:(title,html)=>dialogs.push({title,html}),chooseRecommendation:()=>assert.fail('Viewing a reason must not execute')});hub.bind();await buttons[0].onclick();
 const html=dialogs[0].html;assert.equal((html.match(/class="bh-logic-step"/g)||[]).length,3);assert.match(html,/strategy-art/);assert.match(html,/EMA20/);assert.match(html,/RSI14/);assert.match(html,/连续两根|two RSI closes/);assert.match(html,/&lt;test&gt;/);assert.doesNotMatch(html,/<test>|confidence|置信度|90-day|90天/);assert.match(html,/data-bh="recommendation-source"/);assert.match(html,/data-bh="recommendation"[^>]*disabled/);assert.equal(JSON.stringify(row),before);
});
test('execute refuses stale, unsupported, or mismatched recommendation versions even when a click is synthesized',async()=>{
 const button={dataset:{bh:'recommendation',id:'plan'}},root={querySelectorAll:s=>s==='[data-bh]'?[button]:[],querySelector:()=>null};let selected=0;
 const base={id:'plan',strategy:'S01',variant:'S01-SIM',status:'ready',canAdopt:true,freshness:'current',executable:true,source:{instrument:{profileId:'cex-spot',venueId:'binance'}}};let row=base;
 createBotHub({w:{s:{}},desk:{},root,refresh(){},recommendations:()=>[row],chooseRecommendation:()=>{selected++;return true;}}).bind();
 for(const patch of [{freshness:'expired'},{executable:false},{variant:'baseline'},{canAdopt:false},{source:{instrument:{profileId:'dex-spot',venueId:'binance'}}}]){row={...base,...patch};await button.onclick();assert.equal(selected,0);}
 row=base;await button.onclick();assert.equal(selected,1);
});
test('overview removes duplicate featured tiles while all strategies lead directly to creation',()=>{
 const html=renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}}});
 assert.doesNotMatch(html,/bh-launch-card|data-featured-strategy=/);
 assert.equal((html.match(/data-bot-strategy=/g)||[]).length,18);
 assert.deepEqual([...html.matchAll(/<details data-persist-key="(bh-faq-\d+)"/g)].map(match=>match[1]),['bh-faq-0','bh-faq-1','bh-faq-2','bh-faq-3']);
 assert.doesNotMatch(html,/配置方案|先看依据，再选 Agent/);
 assert.match(html,/data-id="S01"[^>]*>创建|data-id="S01"[^>]*>Create/);
});
test('valid creation routes leave the catalog renderer and invalid ids cannot become a workspace',()=>{
 const previous=globalThis.location;
 try{
  const hub=createBotHub({w:{s:{}},desk:{syncStatus:()=>({scope:{}}),readSnapshot:()=>({botBook:{runs:[]}})}});
  globalThis.location={search:'?page=strategies&create=S01'};assert.equal(hub.render('strategies'),null);
  globalThis.location={search:'?page=strategies&create=%3Cscript%3E'};assert.match(hub.render('strategies'),/data-bot-page="overview"/);
 }finally{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;}
});
test('My Agents has one add action and an explicit overview return',()=>{
 const html=renderBotAssets({w:{s:{drafts:[]}},trade:{botBook:{runs:[]}}});
 assert.equal((html.match(/data-bh="create"/g)||[]).length,1);
 assert.match(html,/data-bh="overview"[^>]*>[\s\S]*?策略总览|data-bh="overview"[^>]*>[\s\S]*?Strategy overview/);
 assert.match(html,/class="bh-sidebar"[\s\S]*?data-bh="choose" data-id="S01"/);
});
test('the tracked Agent tab names a list without becoming the asset tracking action',()=>{
 const html=renderBotAssets({w:{s:{}},trade:{botBook:{runs:[]}}});
 assert.match(html,/data-id="tracked"[^>]*>已追踪 Agent<|data-id="tracked"[^>]*>Tracked Agents</);
 assert.equal(pair('已追踪 Agent','Tracked Agents','en'),'Tracked Agents');
 assert.equal(pair('追踪 BTC','Track BTC','en'),'Track BTC');
});
test('bot assets use the selected account and keep ended holdings visible without counting them as running',()=>{
 const trade={botBook:{runs:[run('a','running'),run('b','stopped',{quantity:.1}),run('c','stopped'),run('d','running',{plan:{strategy:'S01',executionRoute:{accountId:'other'}}})]}};
 const before=JSON.stringify(trade),summary=botHubSummary(trade,'SIM-01');
 assert.equal(summary.activeCount,1);assert.equal(summary.current.length,2);assert.equal(summary.history.length,2);
 assert.equal(summary.pnl,6);assert.equal(summary.fees,.6);assert.equal(JSON.stringify(trade),before);
 assert.deepEqual(filterBotRuns(summary.current,'S01').map(r=>r.id),['a','b']);
 assert.deepEqual(filterBotRuns(summary.current,'S02'),[]);
});
test('unavailable data and unmeasured strategy returns remain unknown',()=>{
 assert.equal(botHubSummary(null).pnl,null);
 const cards=botHubCards({botBook:{runs:[]}});assert.ok(cards.length>=8);
 assert.ok(cards.every(c=>c.pnl===null&&c.roi===null));
 const card=botHubCards({botBook:{runs:[run('x','stopped',{initialAllocation:200,realizedPnl:8,unrealizedPnl:-2})]}}).find(c=>c.id==='S01');
 assert.equal(card.pnl,6);assert.equal(card.roi,3);
});
test('the compact catalog never substitutes mechanism drawings for measured returns',()=>{
 const html=renderBotOverview({w:{s:{drafts:[]}},trade:{botBook:{runs:[]}}});
 assert.equal((html.match(/class="bh-strategy-card"/g)||[]).length,CATALOG.length);
 assert.doesNotMatch(html,/strategy-art|bh-run-curve|data-trading-chart=|90天收益|90-day return/);
 assert.doesNotMatch(html,/bh-return|暂无曲线|No history/);
});
test('every strategy has a direct creation entry and futures capability boundaries remain visible',()=>{
 const w={s:{drafts:[]}},trade={botBook:{runs:[]}};
 assert.deepEqual(new Set(botHubCards(trade).map(c=>c.id)),new Set(CATALOG.map(c=>c.id)));
 const overview=renderBotOverview({w,trade}),assets=renderBotAssets({w,trade});
 for(const {id}of CATALOG){assert.ok(overview.includes(`data-bot-strategy="${id}"`),id);assert.ok(assets.includes(`data-bh="choose" data-id="${id}"`),id);}
 const futures=renderBotOverview({w,trade,category:'futures'});
 for(const {id}of BOT_PRODUCT_CAPABILITIES.filter(p=>p.id.startsWith('perp-')||p.id==='funding-hedge'))assert.ok(futures.includes(`data-bot-product="${id}"`),id);
 assert.match(renderBotOverview({w,trade,category:'onchain'}),/data-bot-strategy="S09-L"/);
});

test('an unavailable selected strategy opens its own plan instead of an unrelated creation shortcut',()=>{
 const html=renderBotAssets({w:{s:{drafts:[]}},trade:{botBook:{runs:[]}},type:'S09-L'});
 assert.match(html,/data-bh="choose" data-id="S09-L"/);assert.match(html,/创建|Create/);
});
test('an embedded signal run keeps identity and guards while grouping diagnostics under its settings',()=>{
 const trade=new TradingDemo();
 assert.equal(trade.start({market:'BTC/USDT',strategy:'S03',mode:'signal',amount:100,cap:500},DEFAULT_CONNECTIONS,{ready:true,market:'BTC/USDT',revision:'r1'}),null);
 trade.state='paused';const data=JSON.parse(JSON.stringify({...trade,flow:trade.flow})),before=JSON.stringify(data),status={state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}};
 const normal=executionView({data,status}),embedded=executionView({data,status,embedded:true});
 assert.match(normal,/添加 Agent|Add Agent/);assert.doesNotMatch(embedded,/添加 Agent|Add Agent|<header class="p-head">/);
 assert.ok(normal.indexOf('execution-run-context')<normal.indexOf('execution-settings'));
 assert.ok(embedded.indexOf('execution-run-context')>embedded.indexOf('execution-settings'));
 assert.match(embedded,/execution-bot-embedded/);assert.match(embedded,/恢复信号追踪|Resume signals/);
 assert.doesNotMatch(embedded,/execution-run-origin/);
 assert.match(embedded,/data-id="resume"/);assert.match(embedded,/data-id="stop"/);
 assert.ok(embedded.indexOf('<aside class="execution-strategy">')<embedded.indexOf('<section class="p-card execution-position">'));
 assert.doesNotMatch(embedded,/<section class="execution-summary">/);assert.equal(JSON.stringify(data),before);
});
test('direct creation chooses a template without approving, saving or creating a run',async()=>{
 const button={dataset:{bh:'create'}},root={querySelectorAll:s=>s==='[data-bh]'?[button]:[],querySelector:()=>null},w={s:{drafts:[]}},before=JSON.stringify(w),chosen=[];
 createBotHub({w,root,desk:{},show:()=>assert.fail('Creation must be a page'),choose:id=>chosen.push(id)}).bind();await button.onclick();
 assert.deepEqual(chosen,['S01']);assert.equal(JSON.stringify(w),before);
});

test('a return curve uses ended paper results in time order, weighted by actual initial allocations',()=>{
 const first=run('first','stopped',{startedAt:1,endedAt:10,initialAllocation:200,realizedPnl:6,unrealizedPnl:0});
 const second=run('second','stopped',{startedAt:1,endedAt:20,initialAllocation:300,realizedPnl:-4,unrealizedPnl:0});
 const held=run('held','stopped',{quantity:.1,startedAt:1,endedAt:15,initialAllocation:100,realizedPnl:50});
 const rows=[second,held,run('active','running'),first],before=JSON.stringify(rows);
 assert.deepEqual(botReturnSeries(rows),[{id:'first',at:10,value:3},{id:'second',at:20,value:.4}]);
 assert.equal(JSON.stringify(rows),before);
 assert.deepEqual(botReturnSeries([run('unknown','stopped')]),[]);
});
test('template cards describe asset scope and never acquire a default or last-run trading pair',()=>{
 const w={s:{drafts:[]}},empty=renderBotOverview({w,trade:{botBook:{runs:[]}}});
 assert.doesNotMatch(empty,/BTC\/USDT|data-token="BTC"/);
 const trade={botBook:{runs:[run('btc','stopped',{orders:[{price:70000,filled:1}]}),run('eth','stopped',{plan:{strategy:'S01',market:'ETH/USDT',executionRoute:{accountId:'SIM-01'}},orders:[{price:3000,filled:1}]})]}};
 const html=renderBotOverview({w,trade});
 assert.doesNotMatch(html,/bh-sparkline|70000|3000|ETH\/USDT|BTC\/USDT/);
 assert.match(html,/bh-card-facts/);assert.ok(botHubCards(trade).every(card=>!Object.hasOwn(card,'market')));
});
test('catalogue keeps all strategy summaries and conditions concise without adding diagram walls',()=>{
 const html=renderBotOverview({w:{s:{drafts:[]}},trade:{botBook:{runs:[]}}});
 assert.equal((html.match(/data-bot-strategy=/g)||[]).length,18);
 assert.equal((html.match(/class="bh-card-facts"/g)||[]).length,18);
 assert.doesNotMatch(html,/bh-mechanism|strategy-art|bh-run-curve/);
});
test('mixed positive and negative closed returns cross the actual zero baseline',()=>{
 const trade={botBook:{runs:[run('up','stopped',{quantity:0,startedAt:1,endedAt:10,initialAllocation:200,realizedPnl:6,unrealizedPnl:0}),run('down','stopped',{quantity:0,startedAt:1,endedAt:20,initialAllocation:300,realizedPnl:-16,unrealizedPnl:0})]}};
 const html=renderBotOverview({w:{s:{drafts:[]}},trade});assert.match(html,/bh-curve-area/);assert.match(html,/bh-curve-baseline" d="M4 29.2H108/);
 assert.match(html,/up.*3%/);assert.match(html,/down.*-2%/);
});
test('the default catalog leads with the two simulation methods while preserving every method and the account',()=>{
 const w={s:{drafts:[]}},trade={botBook:{runs:[]}},before=JSON.stringify({w,trade});
 const html=renderBotOverview({w,trade});
 const ids=[...html.matchAll(/data-bot-strategy="([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(ids.slice(0,2),['S01','S02']);assert.equal(ids.length,18);assert.equal(new Set(ids).size,18);
 assert.doesNotMatch(html,/data-featured-strategy=|data-bh="(?:start|approve|save)"/);
 assert.match(html,/data-bot-strategy="S01" data-simulation-ready="true"/);assert.match(html,/data-bot-strategy="S03" data-simulation-ready="false"/);
 assert.equal(JSON.stringify({w,trade}),before);
});
test('each method keeps a distinct mechanism icon and full entry and exit rules in the shared accessible peek',()=>{
 const w={s:{drafts:[]}},trade={botBook:{runs:[]}},before=JSON.stringify({w,trade});
 const html=renderBotOverview({w,trade});
 const icons=[...html.matchAll(/<span class="bh-card-symbol">(<svg[\s\S]*?<\/svg>)<\/span>/g)].map(m=>m[1]);
 assert.equal(icons.length,CATALOG.length);assert.equal(new Set(icons).size,CATALOG.length);
 assert.equal((html.match(/class="bh-card-rules tc-info"/g)||[]).length,CATALOG.length);
 for(const card of botHubCards(trade)){
  const body=html.split(`data-bot-strategy="${card.id}"`)[1].split('</article>')[0];
  assert.match(body,/策略条件|Setup/);assert.match(body,/退出规则|Exit/);
  assert.ok(body.includes(`data-persist-key="bh-rules-${card.id}"`));
  assert.ok(body.includes(`data-bh="choose" data-id="${card.id}"`));
 }
 assert.equal(JSON.stringify({w,trade}),before);
});
test('research context leads with a valid executable source and keeps other identities available without mutating the feed',()=>{
 const rows=[{id:'wait',strategy:'S03',market:'BTC/USDT',status:'unavailable',canAdopt:false,freshness:'unknown',reason:['等待','Wait']},{id:'research',strategy:'RX03-S',variant:'baseline',market:'ETH/USDT',source:{instrument:{market:'ETH/USDT'}},status:'research',canAdopt:true,freshness:'unknown',reason:['核对资料','Review evidence']},{id:'sim',strategy:'S02',variant:'S02-SIM',market:'SOL/USDT',status:'ready',canAdopt:true,freshness:'current',executable:true,source:{instrument:{profileId:'cex-spot',venueId:'binance'}},reason:['具备条件','Setup present']}];
 const before=JSON.stringify(rows),html=renderBotOverview({w:{s:{drafts:[]}},trade:{botBook:{runs:[]}},recommendations:rows});
 assert.deepEqual([...html.matchAll(/data-recommendation="([^"]+)"/g)].map(m=>m[1]),['sim','research','wait']);
 assert.equal((html.match(/class="bh-suggestion bh-recommendation-card" data-recommendation=/g)||[]).length,3);
 for(const {id}of rows)assert.ok(html.includes(`data-bh="recommendation-logic" data-id="${id}"`));
 assert.equal(JSON.stringify(rows),before);
});
test('simulation-ready filter helps users find executable plans while all types remain complete',()=>{
 const w={s:{drafts:[]}},trade={botBook:{runs:[]}},html=renderBotOverview({w,trade,group:'ready'});
 assert.deepEqual([...html.matchAll(/data-bot-strategy="([^"]+)"/g)].map(m=>m[1]).sort(),['S01','S02']);
 assert.equal((renderBotOverview({w,trade}).match(/data-bot-strategy=/g)||[]).length,18);
});
test('unsupported futures keep their own capability identity and never open a spot configuration',async()=>{
 const w={s:{}},trade={botBook:{runs:[]}},html=renderBotOverview({w,trade,category:'futures'}),choices=[...html.matchAll(/data-bot-product="([^"]+)"[^>]*data-bh="([^"]+)" data-id="([^"]+)"/g)];
 assert.ok(choices.length);for(const [,product,action,id]of choices){assert.equal(action,'capability');assert.equal(id,product);}
 const filtered=renderBotOverview({w,trade,category:'futures',readyOnly:true});assert.doesNotMatch(filtered,/data-bot-product=/);assert.match(filtered,/data-bh="reset"/);
 const button={dataset:{bh:'capability',id:choices[0][1]}},shown=[];
 createBotHub({w,desk:{},root:{querySelector:()=>null,querySelectorAll:s=>s==='[data-bh]'?[button]:[]},show:(title,content)=>shown.push(content),choose:()=>assert.fail('An unsupported contract must not turn into spot')}).bind();
 await button.onclick();assert.equal(shown.length,1);assert.match(shown[0],/尚未适配|Not yet supported/);
});
test('overview names the bot-only totals and leads to configuration without promising an immediate launch',()=>{
 const html=renderBotOverview({w:{s:{drafts:[]}},trade:{botBook:{runs:[]}}});
 assert.match(html,/Agent 资产|Agent assets/);assert.doesNotMatch(html,/模拟账户概览|Paper account overview/);
 assert.match(html,/累计账面盈亏|Cumulative simulated PnL/);assert.match(html,/data-bh="ready-only"/);
 const grid=html.split('data-bot-strategy="S01"')[1].split('</article>')[0];assert.match(grid,/创建|Create/);assert.equal((html.match(/data-bot-strategy=/g)||[]).length,18);
});
test('unavailable opportunities retain a graphical explanation and cannot execute',()=>{
 const rows=[{id:'expired',strategy:'S02',asset:'ETH',status:'unavailable',freshness:'expired',canAdopt:false,reason:['旧结论','Old conclusion'],unavailableReason:['核对最新资料','Check the latest data']},{id:'pending',strategy:'S01',asset:'BTC',status:'ready',freshness:'current',canAdopt:false,executable:true,reason:['等待确认','Waiting for confirmation']}];
 const html=renderBotOverview({w:{s:{drafts:[]}},trade:{botBook:{runs:[]}},recommendations:rows});
 assert.doesNotMatch(html,/data-recommendation="expired"/);
 for(const {id}of rows.filter(row=>row.freshness!=='expired')){const card=html.split(`data-recommendation="${id}"`)[1].split('</article>')[0];assert.equal((card.match(/data-bh="recommendation-logic"/g)||[]).length,1);assert.match(card,/data-bh="recommendation"[^>]*disabled/);}
 const suggestions=html.split('class="bh-suggestions"')[1].split('</section>')[0];assert.doesNotMatch(suggestions,/class="bh-suggestion-state"/);
});

test('missing account data keeps run counts unknown and a filtered empty state offers the way back',()=>{
 const w={s:{drafts:[]}},overview=renderBotOverview({w,trade:null}),unavailable=renderBotAssets({w,trade:null});
 assert.match(overview,/<strong>—<\/strong>/);assert.match(unavailable,/\(—\)/);assert.match(unavailable,/data-bh="connection"/);
 const trade={botBook:{runs:[run('other','running',{plan:{strategy:'S02',executionRoute:{accountId:'SIM-01'}}})]}};
 const filtered=renderBotAssets({w,trade,type:'S01'}).split('class="bh-empty"')[1];assert.match(filtered,/此 Agent 暂无运行实例|No runs for this Agent/);assert.match(filtered,/data-bh="type" data-id="all"/);
 const tracked=renderBotAssets({w,trade,tab:'tracked'}).split('class="bh-empty"')[1];assert.match(tracked,/尚未追踪 Agent|No tracked Agents/);assert.match(tracked,/data-bh="library"/);
});
test('a featured strategy returns to its own launch action after configuration closes without saving or starting',async()=>{
 const previous=globalThis.requestAnimationFrame,w={s:{drafts:[]}},before=JSON.stringify(w),lookups=[];let chosen,back,focus,refreshed=0;
 const button={dataset:{bh:'choose',id:'S01'},closest:selector=>selector==='[data-featured-strategy]'?{}:null};
 const root={scrollTop:37,querySelectorAll:selector=>selector==='[data-bh]'?[button]:[],querySelector:selector=>{lookups.push(selector);return selector==='[data-featured-strategy="S01"] [data-bh="choose"]'?{focus:options=>focus=options}:null;}};
 try{
  globalThis.requestAnimationFrame=callback=>callback();
  createBotHub({w,root,desk:{},refresh:()=>refreshed++,choose:(id,onBack)=>{chosen=id;back=onBack;}}).bind();
  await button.onclick();assert.equal(chosen,'S01');assert.equal(refreshed,0);assert.equal(JSON.stringify(w),before);
  root.scrollTop=0;back();assert.equal(root.scrollTop,37);assert.deepEqual(focus,{preventScroll:true});assert.equal(refreshed,1);assert.equal(JSON.stringify(w),before);
 }finally{globalThis.requestAnimationFrame=previous;}
});
test('choosing from the overview creation dialog returns focus to its original create entry',async()=>{
 const previous=globalThis.requestAnimationFrame;let closeCount=0,back,focus,chosen;
 const dialog={querySelector:()=>({}),close:()=>closeCount++};
 const button={dataset:{bh:'choose',id:'S02'},closest:s=>s==='.product-dialog'?dialog:null};
 const root={scrollTop:120,querySelectorAll:s=>s==='[data-bh]'?[button]:[],querySelector:s=>s==='[data-bh="create"]'?{focus:options=>focus=options}:null};
 try{
  globalThis.requestAnimationFrame=callback=>callback();
  createBotHub({w:{s:{}},root,desk:{},refresh:()=>{},choose:(id,onBack)=>{chosen=id;back=onBack;}}).bind();
  await button.onclick();assert.equal(chosen,'S02');assert.equal(closeCount,1);
  root.scrollTop=0;back();assert.equal(root.scrollTop,120);assert.deepEqual(focus,{preventScroll:true});
 }finally{globalThis.requestAnimationFrame=previous;}
});
test('a scoped library action changes the visible filter and navigates from bot empty states without altering plans',async()=>{
 const previous=globalThis.requestAnimationFrame,frames=[],button={dataset:{bh:'library',id:'ready'}},routes=[];
 const w={s:{drafts:[],botTrackedTypes:[]}},trade={botBook:{runs:[]}},before=JSON.stringify({w,trade});let html='',hub;
 const root={dataset:{renderedPage:'execution'},scrollTop:40,querySelectorAll:s=>s==='[data-bh]'?[button]:[],querySelector:()=>null};
 try{
  globalThis.requestAnimationFrame=f=>frames.push(f);
  hub=createBotHub({w,root,desk:{syncStatus:()=>({}),readSnapshot:()=>trade},go:page=>{routes.push(page);root.dataset.renderedPage=page;html=hub.render(page);},refresh:()=>html=hub.render(root.dataset.renderedPage),choose:()=>assert.fail('A library action must not choose, save or launch')});
  hub.bind();await button.onclick();assert.deepEqual(routes,['strategies']);assert.deepEqual([...html.matchAll(/data-bot-strategy="([^"]+)"/g)].map(m=>m[1]).sort(),['S01','S02']);
  button.dataset.id='';await button.onclick();assert.equal((html.match(/data-bot-strategy=/g)||[]).length,18);assert.equal(JSON.stringify({w,trade}),before);
 }finally{globalThis.requestAnimationFrame=previous;}
});
test('a connected wallet replaces the paper book with its balance and submitted plan',()=>{
 const address='0x'+'ab'.repeat(20);
 const trade={botBook:{runs:[run('paper','running',{allocated:500,equity:503})]},connections:{tradingAccounts:[{id:'wallet-bsc',status:'connected',accountId:address.toUpperCase()}],walletBook:{accountId:address,usdt:18.25,btc:0}}};
 const draft={id:'grid-1',strategy:'S01',market:'BTC/USDT',cap:20,amount:5,executionRoute:{connectionId:'wallet-bsc',accountId:'0x'+'AB'.repeat(20),venueId:'pancakeswap',profileId:'dex-spot',chainId:'56',market:'BTC/USDT'},botParameters:{lower:59000,upper:64000,count:4}};
 const html=renderBotAssets({w:{s:{drafts:[draft,{id:'paper',strategy:'S01',market:'BTC/USDT',cap:9,executionRoute:{accountId:'SIM-01',connectionId:'binance-spot',venueId:'binance',profileId:'cex-spot'}}],botTrackedTypes:[]}},trade,renderInstances:()=>'<article>paper-run</article>',renderSaved:()=>'<article>hidden-paper</article>'});
 assert.match(html,/18\.25/);assert.match(html,/0xabab…abab/);assert.match(html,/data-draft="grid-1"/);assert.match(html,/data-sc="draft"/);assert.match(html,/已提交|Submitted/);assert.match(html,/20/);assert.match(html,/data-plan-account[^>]*>BNB Chain 钱包|data-plan-account[^>]*>BNB Chain wallet/);
 assert.doesNotMatch(html,/SIM-01 · DEMO|paper-run|hidden-paper|累计模拟盈亏|503/);
 const waiting=renderBotAssets({w:{s:{drafts:[],botEditors:{S01:{id:'S01',amount:'',cap:'2.5',mode:'auto',executionRoute:{connectionId:'wallet-bsc',accountId:address,venueId:'pancakeswap',profileId:'dex-spot',chainId:'56',market:'BTC/USDT'},botParameters:{lower:'59000',upper:'64000',count:'4',spacing:'arithmetic'}}}}},trade:{botBook:{runs:[]},connections:{tradingAccounts:[{id:'wallet-bsc',status:'connected',accountId:address}]}}});
 assert.match(waiting,/0xabab…abab/);assert.match(waiting,/data-draft="editor:S01"/);assert.match(waiting,/data-sc="open-editor" data-id="S01"/);assert.match(waiting,/data-bh="delete-plan" data-id="editor:S01"/);assert.match(waiting,/已配置|Configured/);assert.match(waiting,/59,000/);assert.doesNotMatch(waiting,/SIM-01|还没有提交的方案|No submitted plan/);
 const both=renderBotAssets({w:{s:{drafts:[],botEditors:{S02:{id:'S02',cap:0,mode:'auto',executionRoute:{connectionId:'binance-spot',accountId:'BINANCE-SPOT',venueId:'binance',profileId:'cex-spot',chainId:'',market:'BTC/USDT'},botParameters:{deviationPct:2,sizeMultiplier:1.5,maxEntries:3}}}}},trade:{botBook:{runs:[]},connections:{tradingAccounts:[{id:'wallet-bsc',status:'connected',accountId:address},{id:'binance-spot',status:'connected',accountId:'BINANCE-SPOT'}]}}});
 assert.doesNotMatch(both,/data-draft="editor:S02"/);assert.match(both,/还没有提交的方案|No submitted plan/);
});
test('deleting a wallet plan removes the local record and leaves a running plan in place',async()=>{
 const address='0x'+'ab'.repeat(20),store=new Map();
 const editor={id:'S01',cap:2.5,mode:'auto',executionRoute:{connectionId:'wallet-bsc',accountId:address,venueId:'pancakeswap',profileId:'dex-spot',chainId:'56',market:'BTC/USDT'},botParameters:{lower:59000,upper:64000,count:4,spacing:'arithmetic'}};
 const w={s:{drafts:[{id:'grid-1',strategy:'S01',market:'BTC/USDT',cap:20,executionRoute:editor.executionRoute},{id:'D-S03',strategy:'S03'}],selectedDraftId:'grid-1',botEditors:{S01:editor,'S01:draft:grid-1':{...editor,draftId:'grid-1'}}},storage:{getItem:key=>store.has(key)?store.get(key):null,setItem:(key,value)=>store.set(key,value)},touch(){this.touched=(this.touched||0)+1;}};
 const running={botBook:{runs:[{id:'run',status:'running',plan:{id:'grid-1'}}]}};
 assert.equal(await removeLivePlan(w,'grid-1',running),false);assert.equal(w.s.drafts.some(row=>row.id==='grid-1'),true);
 assert.equal(await removeLivePlan(w,'editor:S01'),true);assert.equal(w.s.botEditors.S01,undefined);
 assert.equal(await removeLivePlan(w,'grid-1'),true);assert.deepEqual(w.s.drafts.map(row=>row.id),['D-S03']);assert.equal(w.s.selectedDraftId,'D-S03');
 assert.equal(await removeLivePlan(w,'D-S03'),false);
});
test('checked Binance spot replaces the paper equity with the spot balance',()=>{
 const trade={botBook:{runs:[run('paper','running',{equity:503})]},connections:{tradingAccounts:[{id:'binance-spot',status:'connected',accountId:'BINANCE-SPOT'}],spotBook:{symbol:'BTCUSDT',usdt:24.5,usdtLocked:3,btc:0,btcPrice:60000,orders:[{orderId:'100',side:'BUY',price:'60000',origQty:'0.001',executedQty:'0',status:'NEW',strategy:'S01'}],history:[]}}};
 const html=renderBotAssets({w:{s:{drafts:[{id:'trend-1',strategy:'S03',market:'BTC/USDT',cap:10,executionRoute:{connectionId:'binance-spot',accountId:'BINANCE-SPOT',venueId:'binance',profileId:'cex-spot',chainId:'',market:'BTC/USDT'}}]}},trade,renderInstances:()=>'<article>paper-run</article>'});
 assert.match(html,/共享账户|Shared account/);assert.match(html,/27\.5/);assert.match(html,/data-live-order="100"/);assert.match(html,/data-draft="trend-1"/);assert.match(html,/data-plan-account[^>]*>币安现货|data-plan-account[^>]*>Binance spot/);assert.match(html,/data-statement-account="binance"/);assert.doesNotMatch(html,/paper-run|SIM-01 · DEMO|503/);
 const filled=renderBotAssets({accountKind:'binance',tab:'history',w:{s:{drafts:[]}},trade:{botBook:{runs:[]},connections:{tradingAccounts:[{id:'binance-spot',status:'connected',accountId:'BINANCE-SPOT'}],spotBook:{symbol:'BTCUSDT',usdt:1,usdtLocked:0,btc:0,btcPrice:60000,orders:[],history:[{orderId:'100',side:'BUY',price:'0.00000000',origQty:'0.00008',executedQty:'0.00008',cummulativeQuoteQty:'5',status:'FILLED'}]}}}});
 assert.match(filled,/62,500 USDT/);assert.doesNotMatch(filled,/0\.00000000/);
});
test('wallet balance, exchange equity, plans and trade performance belong to the selected account',()=>{
 const address='0x'+'ab'.repeat(20);
 const connections={tradingAccounts:[{id:'wallet-bsc',status:'connected',accountId:address},{id:'binance-spot',status:'connected',accountId:'BINANCE-SPOT'}],walletBook:{accountId:address.toUpperCase(),usdt:2.5,btc:0.001},spotBook:{symbol:'BTCUSDT',usdt:24.5,usdtLocked:3,btc:0,btcPrice:60000,orders:[],history:[],trades:[{id:'1',orderId:'10',price:60000,qty:0.001,quoteQty:60,commission:0.06,commissionAsset:'USDT',buyer:true,time:1}]}};
 const props={w:{s:{drafts:[]}},trade:{botBook:{runs:[]},connections}};
 const wallet=renderBotAssets(props);
 assert.match(wallet,/2\.5 <small>USDT/);assert.match(wallet,/data-id="wallet" aria-pressed="true"/);assert.match(wallet,new RegExp('bscscan.com/address/'+address));assert.doesNotMatch(wallet,/27\.5 <small>|90 <small>|0\.06<|data-go="assets"/);
 const exchange=renderBotAssets({...props,accountKind:'binance'});
 assert.match(exchange,/27\.5 <small>USDT eq\./);assert.match(exchange,/data-id="binance" aria-pressed="true"/);assert.match(exchange,/0\.06/);assert.doesNotMatch(exchange,/bscscan.com|2\.5 <small>|data-go="assets"/);
 connections.walletBook.accountId='0x'+'cf'.repeat(20);
 assert.match(renderBotAssets(props),/— <small>USDT/);
});
test('bot asset heading links directly to account assets and history without mutating its allocation',()=>{
 const trade={botBook:{runs:[run('active','running',{allocated:500,equity:503,realizedPnl:1,unrealizedPnl:2})]}},before=JSON.stringify(trade);
 const html=renderBotAssets({w:{s:{drafts:[]}},trade,renderInstances:()=>'<article>active</article>'});
 assert.match(html,/<h1[^>]*>(?:我的 Agent|My Agents)<\/h1>/);
 assert.match(html,/data-go="assets"[^>]*>(?:账户资产|Account assets)</);
 assert.match(html,/data-statements="STRATEGY_AGENT"/);assert.doesNotMatch(html,/data-go="logs"/);assert.match(html,/503 <small>USDT/);assert.match(html,/已分配金额|Allocated funds/);assert.equal(JSON.stringify(trade),before);
});
test('strategy overview and My Agents expose one current-account Agent statement entry without unscoped navigation',()=>{
 const w={s:{drafts:[]}},trade={botBook:{runs:[]}},before=JSON.stringify({w,trade});
 for(const render of [renderBotOverview,renderBotAssets]){
  const html=render({w,trade}),entries=[...html.matchAll(/<button\b[^>]*data-statements="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)];
  assert.equal(entries.length,1);assert.equal(entries[0][1],'STRATEGY_AGENT');assert.match(entries[0][0],/aria-haspopup="dialog"/);assert.match(entries[0][0],/交易记录|Trade history/);assert.doesNotMatch(entries[0][0],/data-go=|data-bh=|data-statement-run=|AI_SPECTRUM|SIM-01/);
 }
 const overview=renderBotOverview({w,trade});assert.match(overview,/<div class="bh-account-actions">[\s\S]*?data-statements="STRATEGY_AGENT"[\s\S]*?data-bh="create"/);assert.equal(JSON.stringify({w,trade}),before);
});
test('source-backed suggestions preserve executable gates and omit expired records without calendar fiction',()=>{
 const recommendations=[{id:'signal-1',strategy:'S01',variant:'S01-SIM',asset:'BTC',market:'BTC/USDT',status:'ready',freshness:'current',canAdopt:true,executable:true,source:{instrument:{profileId:'cex-spot',venueId:'binance'}}},{id:'research-2',strategy:'S03',asset:'ETH',market:'ETH/USDT',status:'research',freshness:'unknown',canAdopt:true},{id:'expired-3',strategy:'S02',asset:'SOL',market:'SOL/USDT',status:'unavailable',freshness:'expired',canAdopt:false}];
 const before=JSON.stringify(recommendations),html=renderBotOverview({w:{s:{drafts:[]}},trade:{botBook:{runs:[]}},recommendations});
 assert.equal((html.match(/data-recommendation=/g)||[]).length,2);assert.doesNotMatch(html,/data-recommendation="expired-3"|1970|\bUTC\b|实时最佳|guaranteed/i);assert.equal(JSON.stringify(recommendations),before);
 assert.equal((html.match(/data-bot-strategy=/g)||[]).length,18);
 const featured=html.split('data-recommendation="signal-1"')[1].split('</article>')[0];
 assert.match(featured,/data-bh="recommendation-logic" data-id="signal-1"/);assert.match(featured,/data-bh="recommendation" data-id="signal-1"/);assert.doesNotMatch(featured,/data-bh="recommendation"[^>]*disabled/);assert.match(featured,/bh-pick-asset/);assert.match(featured,/bh-pick-plan/);
 assert.doesNotMatch(html,/class="strategy-art"|data-trading-chart=/);
});

test('an empty research feed offers the catalog without inventing an AI opportunity or changing the account',()=>{
 const w={s:{drafts:[],botTrackedTypes:[]}},trade={botBook:{runs:[]}},before=JSON.stringify({w,trade});
 const html=renderBotOverview({w,trade,recommendations:[]});
 assert.doesNotMatch(html,/data-go="signals"/);assert.equal((html.match(/data-market-entry=/g)||[]).length,0);assert.match(html,/暂无匹配机会|No matching opportunities/);assert.doesNotMatch(html,/策略入口|Strategy entry/);assert.match(html,/data-bh="assets"/);assert.doesNotMatch(html,/data-bh="advisor"/);
 assert.doesNotMatch(html,/data-recommendation=|data-bh="recommendation"|BTC\/USDT|实时最佳|guaranteed|2000 位/);
 assert.equal((html.match(/data-bot-strategy=/g)||[]).length,18);assert.equal(JSON.stringify({w,trade}),before);
});
test('recommendation scopes use explicit source profiles, never strategy names, symbols or chain evidence',()=>{
 for(const profileId of ['cex-spot','cex-perp','dex-spot','dex-perp','dex-lp']){
  const row={strategy:'RX03-S',source:{instrument:{profileId}}},before=JSON.stringify(row),[venue,market]=profileId.split('-');
  assert.deepEqual(botRecommendationScope(row),{profileId,venue,market});assert.equal(JSON.stringify(row),before);
 }
 for(const row of [null,{}, {strategy:'S09-L',market:'ETH/USDT',source:{instrument:{venueId:'uniswap',symbol:'ETH',marketType:'SPOT'},chainId:1}},{source:{instrument:{profileId:'cex-lp'}}}])assert.equal(botRecommendationScope(row),null);
});
test('real recommendations retain all four explicit market colors without manufactured filler',()=>{
 const recommendations=['cex-spot','cex-perp','dex-spot','dex-perp'].map(profileId=>({id:profileId,strategy:'RX03-S',market:'ETH/USDT',source:{instrument:{profileId}},canAdopt:false}));
 const w={s:{drafts:[]}},trade={botBook:{runs:[]}},before=JSON.stringify({w,trade,recommendations});
 const html=renderBotOverview({w,trade,recommendations});
 const cards=[...html.matchAll(/<article class="bh-suggestion bh-recommendation-card" ([\s\S]*?)<\/article>/g)].map(m=>m[1]);
 assert.deepEqual(cards.map(card=>card.match(/data-recommendation-profile="([^"]+)"/)[1]),recommendations.map(row=>row.id));
 for(const card of cards){assert.match(card,/class="bh-ai-market"/);assert.match(card,/bh-pick-plan/);assert.doesNotMatch(card,/data-market-entry=/);assert.match(card,/data-bh="recommendation"[^>]*disabled/);}
 assert.equal(JSON.stringify({w,trade,recommendations}),before);
});

test('unknown and LP recommendations keep their source identity and exact filter semantics',()=>{
 const recommendations=[{id:'perp',strategy:'S03',asset:'ETH',market:'ETH/USDT',status:'unavailable',source:{instrument:{profileId:'cex-perp'}}},{id:'unknown',strategy:'RX03-S',asset:'ETH',status:'research'},{id:'pool',strategy:'S09-L',asset:'ETH',status:'research',source:{instrument:{profileId:'dex-lp'}}}];
 const before=JSON.stringify(recommendations),base={w:{s:{}},trade:{botBook:{runs:[]}},recommendations},html=renderBotOverview(base);
 assert.equal((html.match(/data-recommendation=/g)||[]).length,3);assert.doesNotMatch(html,/data-market-entry=/);
 for(const row of recommendations){const card=html.split(`data-recommendation="${row.id}"`)[1].split('</article>')[0];assert.match(card,new RegExp('data-recommendation-profile="'+(row.source?.instrument.profileId||'')+'"'));}
 const dex=renderBotOverview({...base,recommendationVenue:'dex'});assert.doesNotMatch(dex,/data-recommendation="unknown"|data-recommendation="perp"/);assert.match(dex,/data-recommendation="pool"/);
 const lp=renderBotOverview({...base,recommendationMarket:'lp'});assert.equal((lp.match(/data-recommendation=/g)||[]).length,1);assert.match(lp,/data-recommendation="pool"/);assert.equal(JSON.stringify(recommendations),before);
});

test('recommendation explanations preserve venue and product and unsupported perps cannot become CEX spot',async t=>{
 const previous=globalThis.document,dialogs=[],profiles=['cex-spot','cex-perp','dex-spot','dex-perp'];
 const rows=profiles.map(profileId=>({id:profileId,strategy:'RX03-S',asset:'ETH',market:'ETH/USDT',canAdopt:false,source:{instrument:{profileId}}}));
 const buttons=rows.map(row=>({dataset:{bh:'recommendation-logic',id:row.id}})),w={s:{drafts:[]}},before=JSON.stringify({w,rows});
 const dialog={querySelector:()=>null,querySelectorAll:()=>[]};globalThis.document={querySelector:()=>dialog};t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 createBotHub({w,desk:{},root:{querySelector:()=>null,querySelectorAll:s=>s==='[data-bh]'?buttons:[]},recommendations:()=>rows,show:(title,html)=>dialogs.push(html),choose:()=>assert.fail('Viewing must not configure or execute'),chooseRecommendation:()=>assert.fail('Viewing must not adopt a source')}).bind();
 for(const button of buttons)await button.onclick();assert.equal(dialogs.length,4);
 for(const [i,profile]of profiles.entries()){assert.match(dialogs[i],new RegExp(profile.startsWith('dex')?'链上|DEX':'交易所|CEX'));assert.match(dialogs[i],new RegExp(profile.endsWith('perp')?'合约|Futures':'现货|Spot'));assert.match(dialogs[i],/data-bh="recommendation"[^>]*disabled/);assert.doesNotMatch(dialogs[i],/data-bh="choose"/);}
 assert.equal(JSON.stringify({w,rows}),before);
});

test('adoptable research enters the existing source-bound setup without claiming simulation readiness',async()=>{
 const rows=[{id:'research-dex',strategy:'RX03-S',variant:'baseline',asset:'WETH',market:'WETH/USDC',status:'research',canAdopt:true,executable:false,freshness:'unknown',reason:['链上研究依据','On-chain research evidence'],source:{type:'research',id:'R-1',revision:4,instrument:{market:'WETH/USDC',profileId:'dex-spot',venueId:'uniswap',chainId:'8453'}}}];
 const before=JSON.stringify(rows),html=renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}},recommendations:rows});
 const card=html.split('data-recommendation="research-dex"')[1].split('</article>')[0];assert.match(card,/data-recommendation-profile="dex-spot"/);assert.match(card,/使用此策略|Use this strategy/);assert.doesNotMatch(card,/data-bh="recommendation"[^>]*disabled/);assert.doesNotMatch(card,/可模拟|Simulation ready/);assert.doesNotMatch(card,/链上研究依据|On-chain research evidence/);
 let closed=0;const button={dataset:{bh:'recommendation',id:rows[0].id},closest:selector=>selector==='.product-dialog'?{close:()=>closed++}:null},calls=[];
 const hub=createBotHub({w:{s:{}},desk:{},root:{scrollTop:90,querySelector:()=>null,querySelectorAll:s=>s==='[data-bh]'?[button]:[]},refresh(){},recommendations:()=>rows,chooseRecommendation:(id,back)=>{calls.push(id);return true;},choose:()=>assert.fail('Must not replace an AI source with a generic template')});hub.bind();await button.onclick();assert.deepEqual(calls,[rows[0].id]);assert.equal(closed,1,'the evidence dialog must not cover the source-bound setup');assert.equal(JSON.stringify(rows),before);
 for(const patch of [{freshness:'expired'},{canAdopt:false},{status:'unavailable'},{source:{...rows[0].source,instrument:{...rows[0].source.instrument,profileId:'dex-perp',venueId:'hyperliquid'}}}]){Object.assign(rows[0],patch);await button.onclick();assert.equal(calls.length,1);assert.equal(closed,1);Object.assign(rows[0],JSON.parse(before)[0]);}
});
test('actual adoptable research stays visible ahead of generic entries without guessing its market',()=>{
 const row={id:'actual-lead',strategy:'RX03-S',asset:'ETH',market:'ETH/USDT',status:'research',canAdopt:true,freshness:'unknown',reason:['研究有明确依据','Research evidence is available'],source:{type:'research',id:'research-ETH',revision:4,instrument:{symbol:'ETH',market:'ETH/USDT'}}};
 const html=renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}},recommendations:[row]}),source=html.indexOf('data-recommendation="actual-lead"');
 assert.ok(source>0);assert.doesNotMatch(html,/data-market-entry=/);assert.match(html.slice(source,source+300),/data-recommendation-profile=""/);assert.match(html,/aria-roledescription="carousel"/);
 assert.doesNotMatch(renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}},recommendationVenue:'dex',recommendations:[row]}),/data-recommendation="actual-lead"/);
});
test('creating from a supported market entry returns to that exact entry without adopting a fake source',async t=>{
 const previous={raf:globalThis.requestAnimationFrame,location:globalThis.location},frames=[],focused=[],chosen=[],w={s:{drafts:[]}},before=JSON.stringify(w);
 globalThis.requestAnimationFrame=fn=>frames.push(fn);globalThis.location={search:'?page=strategies'};
 t.after(()=>{if(previous.raf===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=previous.raf;if(previous.location===undefined)delete globalThis.location;else globalThis.location=previous.location;});
 for(const [profile,id]of [['cex-spot','S01'],['dex-spot','S09-A']]){
  const button={dataset:{bh:'choose',id},closest:selector=>selector==='[data-market-entry]'?{dataset:{marketEntry:profile}}:null};let back;
  const root={dataset:{renderedPage:'strategies'},scrollTop:240,querySelectorAll:s=>s==='[data-bh]'?[button]:[],querySelector:selector=>selector===`[data-market-entry="${profile}"] [data-bh="choose"]`?{focus:()=>focused.push(profile)}:null};
  createBotHub({w,desk:{},root,refresh(){},choose:(strategy,onReturn)=>{chosen.push(strategy);back=onReturn;},chooseRecommendation:()=>assert.fail('A market entry must use the template opener')}).bind();
  await button.onclick();assert.equal(chosen.at(-1),id);back();while(frames.length)frames.shift()();assert.equal(focused.at(-1),profile);assert.equal(root.scrollTop,240);
 }
 assert.equal(JSON.stringify(w),before);
});
test('AI venue and market filters retain every matching source and keep liquidity separate from spot',()=>{
 const recommendations=['cex-spot','cex-perp','dex-spot','dex-perp','dex-lp'].map(profileId=>({id:profileId,strategy:'RX03-S',market:'ETH/USDT',status:'research',canAdopt:true,freshness:'unknown',reason:['来源依据','Source evidence'],source:{instrument:{profileId}}}));
 const before=JSON.stringify(recommendations),base={w:{s:{}},trade:{botBook:{runs:[]}},recommendations};
 const ids=options=>[...renderBotOverview({...base,...options}).matchAll(/data-recommendation="([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(ids({}).sort(),recommendations.map(row=>row.id).sort());
 for(const row of recommendations){const [recommendationVenue,recommendationMarket]=row.id.split('-');assert.deepEqual(ids({recommendationVenue,recommendationMarket}),[row.id]);}
 assert.deepEqual(ids({recommendationVenue:'dex'}).sort(),['dex-spot','dex-perp','dex-lp'].sort());
 assert.deepEqual(ids({recommendationMarket:'spot'}),['cex-spot','dex-spot']);
 assert.deepEqual(ids({recommendationMarket:'perp'}),['cex-perp','dex-perp']);
 assert.deepEqual(ids({recommendationVenue:'cex',recommendationMarket:'lp'}),[]);
 const empty=renderBotOverview({...base,recommendationVenue:'cex',recommendationMarket:'lp'});
 assert.match(empty,/data-bh="recommendation-venue"/);assert.match(empty,/data-bh="recommendation-market"/);assert.match(empty,/data-bh="recommendation-reset"/);
 assert.equal((empty.match(/data-bot-strategy=/g)||[]).length,18);assert.equal(JSON.stringify(recommendations),before);
});
test('public AI signals fill all four market styles with every source retained and only supported setup enabled',async()=>{
 const profiles=['cex-spot','cex-perp','dex-spot','dex-perp'];
 const signals=profiles.flatMap((profileId,index)=>[0,1].map(version=>({id:`SIG-${index}-${version}`,sourceId:`AI-${index}`,revision:`v${version}`,runId:`RUN-${index}-${version}`,strategy:'RX03-S',profileId,venueId:profileId==='dex-perp'?'hyperliquid':profileId.startsWith('dex')?'uniswap':'binance',chainId:profileId.startsWith('dex')?'42161':null,market:profileId.startsWith('dex')?'WETH/USDC':'ETH/USDT',marketType:profileId.endsWith('spot')?'SPOT':'PERPETUAL',side:'buy',clockKind:'simulation',observedAt:10,validUntil:100})));
 const w={s:{signals}},before=JSON.stringify(w),recommendations=strategyRecommendations(w,{time:20}),base={w,trade:{botBook:{runs:[]}},recommendations};
 assert.equal(recommendations.length,8);
 const html=renderBotOverview(base);assert.equal((html.match(/class="bh-suggestion bh-recommendation-card"/g)||[]).length,8);assert.doesNotMatch(html,/data-market-entry=/);
 for(const profileId of profiles){
  const [recommendationVenue,recommendationMarket]=profileId.split('-'),filtered=renderBotOverview({...base,recommendationVenue,recommendationMarket}),rows=recommendations.filter(row=>row.source.instrument.profileId===profileId);
  assert.equal((filtered.match(/data-recommendation=/g)||[]).length,2);assert.equal((filtered.match(new RegExp(`data-recommendation-profile="${profileId}"`,'g'))||[]).length,2);
  for(const row of rows){assert.match(filtered,new RegExp(row.sourceId));assert.equal(row.canAdopt,profileId.endsWith('spot'));assert.equal(row.executable,false);}
  const action={dataset:{bh:'recommendation',id:rows[0].id}},selected=[];
  createBotHub({w,desk:{},root:{querySelector:()=>null,querySelectorAll:selector=>selector==='[data-bh]'?[action]:[]},refresh(){},recommendations:()=>recommendations,chooseRecommendation:id=>{selected.push(id);return true;}}).bind();await action.onclick();
  assert.deepEqual(selected,profileId.endsWith('spot')?[rows[0].id]:[]);
 }
 assert.equal(JSON.stringify(w),before);
});
test('unknown markets remain in All and AI decoration cannot promote unsupported sources to simulation ready',()=>{
 const row={id:'unknown',strategy:'S01',asset:'BTC',status:'ready',canAdopt:true,freshness:'current',executable:true,reason:['核对依据','Review evidence']};
 const base={w:{s:{}},trade:{botBook:{runs:[]}}};
 const unknown=renderBotOverview({...base,recommendations:[row]});
 assert.match(unknown,/class="bh-suggestion bh-recommendation-card" data-recommendation="unknown"[^>]+data-recommendation-profile=""/);
 assert.match(unknown,/市场待确认|Confirm market/);assert.match(unknown,/bh-ai-market-unconfirmed/);
 for(const recommendationVenue of ['cex','dex'])assert.doesNotMatch(renderBotOverview({...base,recommendationVenue,recommendations:[row]}),/data-recommendation="unknown"/);
 for(const profileId of ['cex-perp','dex-spot','dex-perp','dex-lp']){
  const html=renderBotOverview({...base,recommendations:[{...row,source:{instrument:{profileId,venueId:'binance'}}}]}).split('class="bh-suggestions"')[1].split('</section>')[0];
  assert.doesNotMatch(html,/可模拟|Simulation ready/);assert.match(html,/data-bh="recommendation"[^>]*disabled/);
 }
 const catalog=unknown.split('<section class="bh-catalog"')[1];assert.doesNotMatch(catalog,/data-ai-tone|bh-ai-meta/);
});

test('missing or invalid recommendation market metadata stays unclassified across every market filter',()=>{
 const base={id:'missing-market',strategy:'RX03-S',asset:'ETH',market:'ETH/USDT',status:'research',canAdopt:true,freshness:'unknown',reason:['来源仍需核对','Review the source']};
 for(const source of [undefined,{instrument:{}},{instrument:{profileId:'cex-unknown'}},{instrument:{profileId:null,venueId:'binance'}}]){
  const row={...base,source},before=JSON.stringify(row),options={w:{s:{}},trade:{botBook:{runs:[]}},recommendations:[row]},html=renderBotOverview(options);
  assert.equal(botRecommendationScope(row),null);assert.match(html,/data-recommendation-profile=""/);assert.match(html,/bh-ai-market-unconfirmed/);assert.match(html,/市场待确认|Confirm market/);
  const card=html.split('data-recommendation="missing-market"')[1].split('</article>')[0];assert.doesNotMatch(card,/CEX ·|DEX ·|可模拟|Simulation ready/);
  for(const profileId of ['cex-spot','cex-perp','dex-spot','dex-perp']){const [recommendationVenue,recommendationMarket]=profileId.split('-');assert.doesNotMatch(renderBotOverview({...options,recommendationVenue,recommendationMarket}),/data-recommendation="missing-market"/);}
  assert.equal(JSON.stringify(row),before);
 }
});
test('each unclassified pick keeps one visual accent across reordering and source revisions without changing its market',()=>{
 const rows=['ETH','SOL','BTC'].map((asset,i)=>({id:'research-'+asset,strategy:['RX03-S','RX02-A','S03'][i],sourceType:'research',sourceId:'research-'+asset,asset,market:asset+'/USDT',status:'research',freshness:'unknown',canAdopt:false})),before=JSON.stringify(rows);
 const render=recommendations=>renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}},recommendations});
 const accents=html=>Object.fromEntries([...html.matchAll(/data-pick-key="([^"]+)" data-recommendation-profile="" data-research-accent="(red|yellow|green|blue)"/g)].map(match=>[match[1],match[2]]));
 const original=accents(render(rows)),updated=accents(render([...rows].reverse().map(row=>({...row,id:row.id+'-v2',asOf:20}))));
 assert.equal(Object.keys(original).length,3);assert.deepEqual(updated,original);assert.ok(new Set(Object.values(original)).size>1);
 for(const row of rows){assert.equal(botRecommendationScope(row),null);const card=render([row]).split('data-recommendation="'+row.id+'"')[1].split('</article>')[0];assert.match(card,/data-bh="recommendation"[^>]*disabled/);}
 const live={id:'live-btc',strategy:'S03',variant:'baseline',asset:'BTC',market:'BTC/USDT',status:'unavailable',canAdopt:false,freshness:'unknown',executable:false,source:{type:'research',id:'market-research-BTC',instrument:{symbol:'BTC',market:'BTC/USDT'}}};
 const liveCard=render([live]).split('data-recommendation="live-btc"')[1].split('</article>')[0];
 assert.doesNotMatch(liveCard,/data-bh="recommendation"[^>]*disabled/);
 const pinned={...live,id:'pinned-perp',source:{instrument:{symbol:'BTC',market:'BTC/USDT',profileId:'cex-perp',venueId:'binance'}}};
 assert.match(render([pinned]),/data-bh="recommendation"[^>]*disabled/);
 const known=render(rows.map(row=>({...row,source:{instrument:{profileId:'cex-spot'}}})));assert.doesNotMatch(known,/data-research-accent=/);assert.equal(JSON.stringify(rows),before);
});
test('changing or resetting AI filters preserves catalog filters, source identities and account state, with focus returned',async()=>{
 const previous=globalThis.requestAnimationFrame,frames=[],focused=[];
 const fields=['group','sort','recommendationVenue','recommendationMarket'].map(bhSelect=>({dataset:{bhSelect},value:'all',focus:()=>focused.push(bhSelect)}));
 const reset={dataset:{bh:'recommendation-reset'}},track={dataset:{bh:'tracked-only'}},ready={dataset:{bh:'ready-only'}};
 const root={querySelectorAll:s=>s==='[data-bh]'?[reset,track,ready]:s==='[data-bh-select]'?fields:[],querySelector:s=>s==='[data-bh="recommendation-venue"][data-id="all"]'?fields[2]:fields.find(f=>s===`[data-bh-select="${f.dataset.bhSelect}"]`)};
 const w={s:{drafts:[],botTrackedTypes:['S01']}},trade={botBook:{runs:[]}},before=JSON.stringify({w,trade});let html='',hub;
 const row={id:'original:source:version',strategy:'S01',asset:'BTC',status:'research',canAdopt:true,freshness:'unknown',reason:['来源依据','Source evidence'],source:{instrument:{profileId:'cex-spot'}}};
 try{
  globalThis.requestAnimationFrame=f=>frames.push(f);
  hub=createBotHub({w,root,desk:{syncStatus:()=>({}),readSnapshot:()=>trade},recommendations:()=>[row],refresh:()=>html=hub.render('strategies'),choose:()=>assert.fail('Filtering must not open or execute a plan')});hub.bind();
  fields[0].value='range';fields[0].onchange();fields[1].value='runs';fields[1].onchange();await track.onclick();await ready.onclick();
  fields[2].value='dex';fields[2].onchange();fields[3].value='perp';fields[3].onchange();
  assert.doesNotMatch(html,/data-recommendation="original:source:version"/);assert.match(html,/<option value="runs" selected>/);
  assert.match(html,/data-bh="recommendation-venue" data-id="dex" aria-pressed="true"/);assert.match(html,/data-bh="recommendation-market" data-id="perp" aria-pressed="true"/);
  await reset.onclick();while(frames.length)frames.shift()();
  assert.match(html,/data-recommendation="original:source:version"/);assert.match(html,/<option value="range" selected>/);assert.match(html,/data-bh="ready-only"[^>]*aria-pressed="true"/);assert.match(html,/<option value="runs" selected>/);
  assert.equal((html.match(/data-bot-strategy=/g)||[]).length,1);assert.equal(focused.at(-1),'recommendationVenue');assert.equal(JSON.stringify({w,trade}),before);
 }finally{globalThis.requestAnimationFrame=previous;}
});
test('opportunity segments keep keyboard selection and focus inside their own filter',async()=>{
 const previous=globalThis.requestAnimationFrame,frames=[],focused=[];
 const groups=['venue','market'].map((key,g)=>{
  const buttons=(g?['all','spot','perp','lp']:['all','cex','dex']).map(id=>({dataset:{bh:'recommendation-'+key,id},focus:()=>focused.push(key+':'+id),getBoundingClientRect:()=>({left:0,right:70,width:70})}));
  return {buttons,querySelectorAll:()=>buttons,querySelector:()=>buttons[0],getBoundingClientRect:()=>({left:0,right:200}),scrollWidth:200,clientWidth:200};
 });
 const buttons=groups.flatMap(group=>group.buttons),root={querySelectorAll:s=>s==='[data-bh]'?buttons:s.includes('.bh-recommendation-segment')?groups:[],querySelector:s=>buttons.find(b=>s.includes('data-bh="'+b.dataset.bh+'"')&&s.includes('data-id="'+b.dataset.id+'"'))};
 const w={s:{drafts:[]}},trade={botBook:{runs:[]}},before=JSON.stringify({w,trade});let html='',hub,prevented=0;
 try{
  globalThis.requestAnimationFrame=f=>frames.push(f);
  hub=createBotHub({w,root,desk:{syncStatus:()=>({}),readSnapshot:()=>trade},refresh:()=>html=hub.render('strategies'),choose:()=>assert.fail('A filter must not create or execute an Agent')});hub.bind();
  const initial=hub.render('strategies');assert.match(initial,/data-bh="recommendation-venue" data-id="cex" aria-pressed="false" tabindex="-1"/);
  await groups[0].buttons[0].onkeydown({key:'End',preventDefault:()=>prevented++});while(frames.length)frames.shift()();
  assert.match(html,/data-bh="recommendation-venue" data-id="dex" aria-pressed="true" tabindex="0"/);assert.equal(focused.at(-1),'venue:dex');
  await groups[1].buttons[0].onkeydown({key:'ArrowLeft',preventDefault:()=>prevented++});while(frames.length)frames.shift()();
  assert.match(html,/data-bh="recommendation-market" data-id="lp" aria-pressed="true" tabindex="0"/);assert.equal(focused.at(-1),'market:lp');
  await groups[0].buttons[2].onkeydown({key:'Home',preventDefault:()=>prevented++});while(frames.length)frames.shift()();
  assert.match(html,/data-bh="recommendation-venue" data-id="all" aria-pressed="true" tabindex="0"/);assert.equal(focused.at(-1),'venue:all');
  assert.equal(prevented,3);assert.equal(JSON.stringify({w,trade}),before);
 }finally{globalThis.requestAnimationFrame=previous;}
});
test('overview separates account creation, bot types and source-backed research in that order',()=>{
 const rows=[{id:'source',strategy:'S02',market:'ETH/USDT',status:'ready',canAdopt:true,executable:true,freshness:'current',source:{instrument:{profileId:'cex-spot',venueId:'binance'}},reason:['价格偏离','Price deviation']}];
 const html=renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}},recommendations:rows});
 const account=html.indexOf('class="bh-overview-account"'),suggestions=html.indexOf('class="bh-suggestions"'),catalog=html.indexOf('<section class="bh-catalog"');
 assert.ok(account<suggestions&&suggestions<catalog);assert.doesNotMatch(html,/bh-products|bh-launch-card/);
 assert.match(html.slice(account,suggestions),/class="bh-button p-button bh-primary p-primary" data-bh="create"/);
 assert.doesNotMatch(html,/bh-overview-mosaic|bh-saasfly-features|data-bh="(?:start|approve)"/);
 const futures=renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}},category:'futures',recommendations:rows});
 assert.match(futures,/data-recommendation="source"/);
 const onchain=renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}},category:'onchain',recommendationVenue:'dex',recommendations:rows});
 assert.doesNotMatch(onchain,/data-recommendation="source"/);
 const pool={id:'pool',strategy:'S09-L',asset:'ETH',status:'research',canAdopt:true,freshness:'unknown',source:{instrument:{profileId:'dex-lp',venueId:'uniswap'}},reason:['核对池数据','Review pool data']};
 const spot=renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}},category:'spot',recommendationMarket:'spot',recommendations:[...rows,pool]});
 assert.match(spot,/data-recommendation="source"/);assert.doesNotMatch(spot,/data-recommendation="pool"/);
 assert.match(renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}},category:'onchain',recommendations:[...rows,pool]}),/data-recommendation="pool"/);
});
test('exploring the strategy library restores its visible category without selecting, saving or starting a bot',async()=>{
 const previous=globalThis.requestAnimationFrame,frames=[],buttons=[{dataset:{bh:'category',id:'futures'}},{dataset:{bh:'library'}}];
 const w={s:{drafts:[],botTrackedTypes:[]}},trade={botBook:{runs:[]}},before=JSON.stringify({w,trade});let rendered='',hub;
 const root={scrollTop:420,querySelectorAll:s=>s==='[data-bh]'?buttons:[],querySelector:()=>null};
 try{
  globalThis.requestAnimationFrame=f=>frames.push(f);
  hub=createBotHub({w,root,desk:{syncStatus:()=>({}),readSnapshot:()=>trade},refresh:()=>rendered=hub.render('strategies'),choose:()=>assert.fail('Browsing must not choose a plan')});
  hub.bind();await buttons[0].onclick();assert.match(rendered,/data-bot-product="perp-grid"/);assert.doesNotMatch(rendered,/data-bot-strategy=/);
  await buttons[1].onclick();assert.doesNotMatch(rendered,/<section class="bh-catalog" hidden/);assert.equal((rendered.match(/data-bot-strategy=/g)||[]).length,18);
  frames.shift()();assert.equal(JSON.stringify({w,trade}),before);
 }finally{globalThis.requestAnimationFrame=previous;}
});
test('adopting a recommendation calls the existing preparer with identity and restores its caller without starting a bot',async()=>{
 const row={id:'SOURCE-1',strategy:'S01',variant:'S01-SIM',market:'BTC/USDT',canAdopt:true,status:'ready',freshness:'current',executable:true,source:{instrument:{profileId:'cex-spot',venueId:'binance'}}},frames=[],previous=globalThis.requestAnimationFrame;let selected,back,focused=false;
 const button={dataset:{bh:'recommendation',id:row.id},focus(){focused=true;}},root={scrollTop:310,querySelector:()=>null,querySelectorAll:s=>s==='[data-bh]'||s==='[data-bh="recommendation"]'?[button]:[]};
 const trade={botBook:{runs:[]}},before=JSON.stringify(trade);try{
  globalThis.requestAnimationFrame=f=>{frames.push(f);return frames.length;};
  const hub=createBotHub({w:{s:{drafts:[]}},root,desk:{readSnapshot:()=>trade},go:page=>assert.equal(page,'strategies'),refresh:()=>{},recommendations:()=>[row],choose:()=>assert.fail('Must use source-bound preparer'),chooseRecommendation:(id,onReturn)=>{selected=id;back=onReturn;return true;}});hub.bind();await button.onclick();assert.equal(selected,row.id);assert.equal(JSON.stringify(trade),before);assert.equal(frames.length,0);root.scrollTop=0;back();frames.shift()();assert.equal(root.scrollTop,310);assert.equal(focused,true);
 }finally{globalThis.requestAnimationFrame=previous;}
});
test('returning after a source refresh preserves market filters and focuses the recommendation heading instead of a missing record',async t=>{
 const previous=globalThis.requestAnimationFrame,frames=[],focused=[],w={s:{drafts:[]}},before=JSON.stringify(w);let back,html;
 let rows=[{id:'source-v1',strategy:'RX03-S',variant:'baseline',status:'research',canAdopt:true,freshness:'unknown',asset:'ETH',market:'ETH/USDT',source:{instrument:{profileId:'cex-spot',venueId:'binance'}},reason:['研究依据','Research evidence']}];
 const buttons=[{dataset:{bh:'recommendation-venue',id:'cex'}},{dataset:{bh:'recommendation-market',id:'spot'}},{dataset:{bh:'recommendation',id:'source-v1'}}],heading={focus:()=>focused.push('heading')};
 const root={dataset:{renderedPage:'strategies'},scrollTop:390,querySelector:s=>s==='#bh-suggestions-title'?heading:null,querySelectorAll:s=>s==='[data-bh]'?buttons:s==='[data-bh="recommendation"]'&&rows.length?[buttons[2]]:[]};
 globalThis.requestAnimationFrame=fn=>frames.push(fn);t.after(()=>{if(previous===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=previous;});
 const hub=createBotHub({w,desk:{syncStatus:()=>({scope:{accountId:'SIM-01',environment:'DEMO'}}),readSnapshot:()=>({botBook:{runs:[]}})},root,refresh:()=>html=hub.render('strategies'),recommendations:()=>rows,chooseRecommendation:(id,onReturn)=>{assert.equal(id,'source-v1');back=onReturn;return true;}});hub.bind();
 await buttons[0].onclick();await buttons[1].onclick();while(frames.length)frames.shift()();await buttons[2].onclick();
 rows=[];root.scrollTop=0;back();while(frames.length)frames.shift()();
 assert.match(html,/data-bh="recommendation-venue" data-id="cex" aria-pressed="true"/);assert.match(html,/data-bh="recommendation-market" data-id="spot" aria-pressed="true"/);assert.equal(root.scrollTop,390);assert.equal(focused.at(-1),'heading');assert.equal(heading.tabIndex,-1);assert.equal(JSON.stringify(w),before);
});
test('expired sources stay readable through their exact source opener and return to the same card without route guessing',async()=>{
 const row={id:'signal:version:run-2:signal-4',canAdopt:true,status:'ready',freshness:'expired',sourceHref:'javascript:alert(1)'},frames=[],previous=globalThis.requestAnimationFrame,calls=[];let focused=false,refreshed=0,back;
 const buttons=[{dataset:{bh:'recommendation',id:row.id}},{dataset:{bh:'recommendation-source',id:row.id},focus(){focused=true;}}],root={scrollTop:280,dataset:{renderedPage:'strategies'},querySelector:()=>null,querySelectorAll:s=>s==='[data-bh]'?buttons:s==='[data-bh="recommendation-source"]'?[buttons[1]]:[]};
 try{
  globalThis.requestAnimationFrame=f=>{frames.push(f);return frames.length;};
  const hub=createBotHub({w:{s:{drafts:[]}},root,desk:{},refresh:()=>refreshed++,recommendations:()=>[row],chooseRecommendation:(id,onReturn,options)=>{calls.push({id,options});back=onReturn;return id===row.id;},go:()=>assert.fail('Source metadata must not become a guessed route')});hub.bind();await buttons[0].onclick();assert.equal(calls.length,0);await buttons[1].onclick();assert.deepEqual(calls,[{id:row.id,options:{intent:'source'}}]);assert.equal(frames.length,0);root.scrollTop=0;back();frames.shift()();assert.equal(root.scrollTop,280);assert.equal(focused,true);
  buttons[1].dataset.id='missing-source';await buttons[1].onclick();assert.equal(calls.at(-1).id,'missing-source');assert.equal(refreshed,3);
 }finally{globalThis.requestAnimationFrame=previous;}
});
test('an existing signal strategy keeps its own section and the same active count on both pages',()=>{
 const w={s:{drafts:[]}},trade={session:{id:'old',strategy:'S03'},state:'running',botBook:{runs:[]}};
 assert.equal(botHubSummary(trade).activeCount,1);
 const html=renderBotAssets({w,trade,renderLegacy:active=>active?'old-run-actions':''});
 assert.match(html,/bh-existing-run/);assert.match(html,/old-run-actions/);assert.match(html,/\(1\)/);
 assert.match(renderBotOverview({w,trade}),/<strong>1<\/strong>/);
});
test('overview and assets have separate page structures and honest empty states',()=>{
 const w={s:{drafts:[],botTrackedTypes:[]}},trade={botBook:{runs:[]},cash:10000};
 const overview=renderBotOverview({w,trade});
 assert.match(overview,/data-bot-page="overview"/);assert.match(overview,/data-bh="assets"/);
 assert.doesNotMatch(overview,/data-strategy-workspace-host|躺赢|711,541/);
 const assets=renderBotAssets({w,trade,accountId:'SIM-01'});
 assert.match(assets,/data-bot-page="assets"/);assert.match(assets,/bh-sidebar/);
 assert.match(assets,/data-bh="tab"/);assert.match(assets,/data-bh="overview"/);
 assert.doesNotMatch(assets,/90天总收益|24小时收益/);
 assert.match(renderBotAssets({w,trade:null}),/data-bh="connection"/);
});
test('history and type filters exclude active runs and other types without changing the ledger',()=>{
 const trade={botBook:{runs:[run('live','running'),run('old','stopped'),run('other','stopped',{plan:{strategy:'S02',market:'ETH/USDT',executionRoute:{accountId:'SIM-01'}}})]}};
 let received;
 renderBotAssets({w:{s:{drafts:[]}},trade,accountId:'SIM-01',tab:'history',type:'S02',renderInstances:(data,history)=>{received={data,history};return 'rendered';}});
 assert.equal(received.history,true);assert.deepEqual(received.data.botBook.runs.map(r=>r.id),['other']);
 assert.equal(trade.botBook.runs.length,3);
});
test('saved drafts stay separate from the current-bot empty state and do not hide creation',()=>{
 const html=renderBotAssets({w:{s:{drafts:[{id:'draft-only'}]}},trade:{botBook:{runs:[]}},renderSaved:()=>'<article>draft-only</article>'});
 assert.match(html,/暂无 Agent 运行|No Agent runs/);
 assert.match(html,/data-bh="create"/);assert.match(html,/bh-saved-plans/);
 assert.ok(html.indexOf('draft-only')>html.indexOf('bh-empty'));
 assert.doesNotMatch(html,/<details[^>]*bh-saved-plans[^>]*\sopen/);
});
test('ended holdings remain assets in a separate section without becoming an active bot',()=>{
 const trade={botBook:{runs:[run('retained','stopped',{quantity:.1})]}},seen=[];
 const html=renderBotAssets({w:{s:{drafts:[]}},trade,renderInstances:data=>{seen.push(data.botBook.runs[0].id);return '<article>retained-run</article>';}});
 assert.equal(botHubSummary(trade).activeCount,0);assert.deepEqual(seen,['retained']);
 assert.match(html,/已结束 · 保留持仓|Ended · retained holdings/);assert.match(html,/\(0\)/);assert.match(html,/retained-run/);
});
test('run links resolve only existing records in the readable account and environment',()=>{
 const scope={accountId:'SIM-01',environment:'DEMO'},trade={session:{id:'SIM-1',strategy:'S03',accountId:'SIM-01',environment:'DEMO'},state:'paused',botBook:{runs:[run('live','paused'),run('ended','stopped'),run('held','stopped',{quantity:.1}),run('foreign','running',{plan:{executionRoute:{accountId:'other',environment:'DEMO'}}}),run('live-env','running',{plan:{executionRoute:{accountId:'SIM-01',environment:'LIVE'}}})]}};
 const before=JSON.stringify(trade);
 assert.deepEqual(botRunTarget(trade,scope,'live'),{id:'live',tab:'current'});
 assert.deepEqual(botRunTarget(trade,scope,'ended'),{id:'ended',tab:'history'});
 assert.deepEqual(botRunTarget(trade,scope,'held'),{id:'held',tab:'current'});
 assert.deepEqual(botRunTarget(trade,scope,'SIM-1'),{id:'SIM-1',tab:'current'});
 for(const id of ['missing','foreign','live-env'])assert.equal(botRunTarget(trade,scope,id),null);
 assert.equal(botRunTarget(trade,{accountId:'other',environment:'DEMO'},'SIM-1'),null);
 assert.equal(botRunTarget(null,scope,'SIM-1'),null);assert.equal(JSON.stringify(trade),before);
 const html=renderBotAssets({w:{s:{drafts:[]}},trade,runId:'foreign',renderInstances:()=>'<article>own runs</article>'});assert.match(html,/bh-run-notice/);assert.match(html,/当前账户中未找到这条运行|not available in this account/);
});
test('a run link selects the matching history tab and reveals it once without changing the ledger',()=>{
 const previous={location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame},frames=[];let focused=0;
 const trade={botBook:{runs:[run('ended','stopped')]}},before=JSON.stringify(trade);
 const target={dataset:{botInstance:'ended'},classList:{add(){}},getBoundingClientRect:()=>({top:300}),focus:options=>{assert.deepEqual(options,{preventScroll:true});focused++;}};
 const root={scrollTop:0,getBoundingClientRect:()=>({top:60}),querySelector:()=>null,querySelectorAll:selector=>selector.startsWith('[data-bot-instance]')?[target]:[]};
 try{
  globalThis.location={search:'?page=execution&runId=ended'};globalThis.requestAnimationFrame=fn=>frames.push(fn);
  const hub=createBotHub({w:{s:{drafts:[]}},root,desk:{syncStatus:()=>({scope:{accountId:'SIM-01',environment:'DEMO'}}),readSnapshot:()=>trade},renderInstances:()=>'<article>ended</article>'});
  assert.match(hub.render('execution'),/aria-selected="true" data-bh="tab" data-id="history"/);
  hub.bind();frames.shift()();assert.equal(root.scrollTop,216);assert.equal(focused,1);
  hub.render('execution');hub.bind();frames.shift()();assert.equal(focused,1);assert.equal(JSON.stringify(trade),before);
 }finally{for(const key of Object.keys(previous))if(previous[key]===undefined)delete globalThis[key];else globalThis[key]=previous[key];}
});
test('choosing a bot opens the same editor in place and does not navigate, launch or debit',async()=>{
 const steps=[],buttons=[{dataset:{bh:'choose',id:'S01'}},{dataset:{bh:'type',id:'S02'}}];
 const w={s:{drafts:[]},touch(){throw Error('Browsing must not persist or approve');}};
 const root={querySelectorAll:s=>s==='[data-bh]'?buttons:[],querySelector:()=>null};
 const hub=createBotHub({w,desk:{},root,go:page=>steps.push(['go',page]),refresh:()=>steps.push(['refresh']),choose:id=>steps.push(['settings',id])});
 hub.bind();await buttons[0].onclick();assert.deepEqual(steps,[['settings','S01']]);
 await buttons[1].onclick();assert.deepEqual(steps.at(-1),['refresh']);assert.deepEqual(w.s,{drafts:[]});
});

test('sidebar scroll survives background render and active-item reveal without crossing account, environment or page',t=>{
 const saved={requestAnimationFrame:globalThis.requestAnimationFrame,location:globalThis.location};t.after(()=>{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const frames=[],trade={botBook:{runs:[]}},before=JSON.stringify(trade);let scope={accountId:'A',environment:'DEMO'},sidebar=null;
 globalThis.requestAnimationFrame=fn=>frames.push(fn);globalThis.location={search:'?page=execution'};
 const makeSidebar=()=>({scrollTop:0,scrollHeight:1700,clientHeight:530,isConnected:true,classList:{contains:n=>n==='bh-sidebar'},getBoundingClientRect:()=>({top:60,bottom:590}),querySelector:()=>({getBoundingClientRect:()=>({top:72-sidebar.scrollTop,bottom:112-sidebar.scrollTop,height:40})})});
 const root={dataset:{renderedPage:'execution'},querySelector:s=>s==='.bh-sidebar'?sidebar:null,querySelectorAll:s=>s.includes('.bh-assets-tabs')&&sidebar?[sidebar]:[]};
 const hub=createBotHub({w:{s:{drafts:[]}},root,desk:{syncStatus:()=>({scope}),readSnapshot:()=>trade}});
 const paint=page=>{hub.render(page);sidebar=page==='execution'?makeSidebar():null;root.dataset.renderedPage=page;hub.bind();while(frames.length)frames.shift()();};
 paint('execution');sidebar.scrollTop=1104;paint('execution');assert.equal(sidebar.scrollTop,1104);
 paint('execution');assert.equal(sidebar.scrollTop,1104);
 scope={accountId:'B',environment:'DEMO'};paint('execution');assert.equal(sidebar.scrollTop,0);
 sidebar.scrollTop=400;scope={accountId:'B',environment:'LIVE'};paint('execution');assert.equal(sidebar.scrollTop,0);
 sidebar.scrollTop=500;paint('strategies');paint('execution');assert.equal(sidebar.scrollTop,0);assert.equal(JSON.stringify(trade),before);
});
test('closing an in-place editor restores the original list position without replacing its filters',async()=>{
 const previous=globalThis.requestAnimationFrame,frames=[];let back,focused,refreshes=0;
 const button={dataset:{bh:'choose',id:'S09-L'},focus:options=>focused=options},root={scrollTop:540,querySelectorAll:s=>s==='[data-bh]'?[button]:[],querySelector:s=>s.includes('data-id="S09-L"')?button:null};
 try{
  globalThis.requestAnimationFrame=fn=>frames.push(fn);
  const hub=createBotHub({w:{s:{}},root,desk:{},go:()=>assert.fail('Choosing must stay on the original page'),choose:(_,callback)=>back=callback,refresh:()=>refreshes++});
  hub.bind();await button.onclick();root.scrollTop=0;back();frames.shift()();assert.equal(root.scrollTop,540);assert.equal(refreshes,1);assert.deepEqual(focused,{preventScroll:true});
 }finally{if(previous===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=previous;}
});
test('returning from a catalog card restores that trigger rather than its matching recommended tile',async()=>{
 const previous=globalThis.requestAnimationFrame,frames=[];let back,focus;
 const cardSelector='[data-bot-strategy="S00"] [data-bh="choose"]';
 const button={dataset:{bh:'choose',id:'S00'},closest:selector=>selector==='[data-bot-strategy]'?{}:null};
 const root={scrollTop:615,querySelectorAll:selector=>selector==='[data-bh]'?[button]:[],querySelector:selector=>selector.includes('choose')?{focus:()=>focus=selector}:null};
 try{
  globalThis.requestAnimationFrame=fn=>frames.push(fn);
  createBotHub({w:{s:{}},root,desk:{},choose:(_,callback)=>back=callback,refresh(){}}).bind();
  await button.onclick();back();frames.shift()();assert.equal(focus,cardSelector);assert.equal(root.scrollTop,615);
 }finally{if(previous===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=previous;}
});
test('execution methods without adapters are not presented as available research strategies',async()=>{
 let body;const button={dataset:{bh:'capability',id:'spot-twap'}},root={querySelectorAll:selector=>selector==='[data-bh]'?[button]:[],querySelector:()=>null};
 createBotHub({w:{s:{}},root,desk:{},show:(_,html)=>body=html}).bind();await button.onclick();
 assert.match(body,/尚未适配|Not yet supported/);assert.doesNotMatch(body,/<h3>研究方案<\/h3>/);
});
test('unready runs have an original-connection action without rebinding or resuming the instance',async()=>{
 const item=run('needs-access','interrupted',{plan:{strategy:'S01',market:'BTC/USDT',executionRoute:{accountId:'SIM-01',connectionId:'original',venueId:'binance'}}});
 const trade={botBook:{runs:[item]}},before=JSON.stringify(trade),w={s:{drafts:[]}};
 const html=renderBotAssets({w,trade,renderInstances:()=>'<article>run</article>',accessFor:()=>({ready:false,code:'connection-unchecked'})});
 assert.match(html,/data-bh="run-connection" data-id="needs-access"/);assert.match(html,/SIM-01/);
 let settings;
 const button={dataset:{bh:'run-connection',id:'needs-access'}},root={querySelectorAll:s=>s==='[data-bh]'?[button]:[],querySelector:()=>null};
 createBotHub({w,root,desk:{readSnapshot:()=>trade,settings:(section,options)=>settings={section,options}},refresh:()=>{}}).bind();
 await button.onclick();assert.equal(settings.section,'exchange');assert.equal(settings.options.connectionId,'original');assert.equal(settings.options.service,'binance');
 assert.equal(JSON.stringify(trade),before);
});
test('bot search preserves composition and selection until a Chinese query is committed',()=>{
 const previous={document:globalThis.document,requestAnimationFrame:globalThis.requestAnimationFrame},events={},frames=[];let renders=0,selection;
 const input={value:'wangge',isConnected:true,selectionStart:2,selectionEnd:2,selectionDirection:'none',addEventListener:(event,fn)=>events[event]=fn,focus(){},setSelectionRange:(...value)=>selection=value};
 const root={querySelectorAll:()=>[],querySelector:selector=>selector==='[data-bh-search]'?input:null},desk={syncStatus:()=>({scope:{accountId:'SIM-01'}}),readSnapshot:()=>({botBook:{runs:[]}})};
 try{
  globalThis.document={activeElement:input};globalThis.requestAnimationFrame=fn=>frames.push(fn);
  const hub=createBotHub({w:{s:{drafts:[]}},desk,root,refresh:()=>renders++});hub.bind();
  events.compositionstart();events.input({isComposing:true});assert.equal(renders,0);assert.equal(frames.length,0);
  input.value='网格';events.compositionend();assert.equal(renders,0);frames.shift()();assert.equal(renders,1);
  assert.deepEqual(selection,[2,2,'none']);const html=hub.render('strategies');assert.match(html,/data-bot-strategy="S01"/);assert.doesNotMatch(html,/data-bot-strategy="S02"/);
 }finally{for(const key of Object.keys(previous))if(previous[key]===undefined)delete globalThis[key];else globalThis[key]=previous[key];}
});
test('a selected mobile tab and type remain visible without moving the page vertically',()=>{
 const previous=globalThis.requestAnimationFrame,frames=[];
 const strip=(width,selectedLeft,selectedWidth)=>{
  let offset=0;
  return {scrollWidth:width,clientWidth:288,get scrollLeft(){return offset;},set scrollLeft(v){offset=Math.max(0,Math.min(width-288,v));},getBoundingClientRect:()=>({left:16,right:304,width:288}),querySelector:()=>({getBoundingClientRect:()=>({left:selectedLeft-offset,right:selectedLeft+selectedWidth-offset,width:selectedWidth})})};
 };
 const tabs=strip(312,246,68),types=strip(760,650,84),root={querySelectorAll:selector=>selector.includes('.bh-assets-tabs')?[tabs,types]:[],querySelector:()=>null};
 try{
  globalThis.requestAnimationFrame=fn=>frames.push(fn);
  createBotHub({w:{s:{}},desk:{},root}).bind();frames.shift()();
  for(const nav of [tabs,types]){const box=nav.querySelector().getBoundingClientRect();assert.ok(box.left>=16&&box.right<=304);}
 }finally{if(previous===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=previous;}
});
test('a selected item remains visible inside the independently scrolling strategy sidebar',()=>{
 const previous=globalThis.requestAnimationFrame,frames=[];let offset=0;
 const aside={classList:{contains:key=>key==='bh-sidebar'},clientHeight:300,get scrollTop(){return offset;},set scrollTop(v){offset=Math.max(0,Math.min(900,v));},getBoundingClientRect:()=>({top:60,bottom:360,height:300}),querySelector:()=>({getBoundingClientRect:()=>({top:960-offset,bottom:1008-offset,height:48})})};
 const root={querySelectorAll:selector=>selector.includes('.bh-sidebar')?[aside]:[],querySelector:()=>null};
 try{globalThis.requestAnimationFrame=fn=>frames.push(fn);createBotHub({w:{s:{}},desk:{},root}).bind();frames.shift()();const box=aside.querySelector().getBoundingClientRect();assert.ok(box.top>=60&&box.bottom<=360);}
 finally{if(previous===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=previous;}
});

function recommendationRailHarness(){
 const w={s:{drafts:[]}},trade={botBook:{runs:[]}},scrolls=[],routes=[],focus=[];
 const controls={hidden:false},buttons=['recommendation-prev','recommendation-next','recommendation-venue','recommendation-reset','advisor'].map(bh=>({dataset:{bh,id:bh==='recommendation-venue'?'dex':''},focus:()=>focus.push(bh)}));
 const makeRail=()=>({scrollWidth:2544,clientWidth:944,scrollLeft:0,isConnected:true,
  querySelector:selector=>selector==='.bh-suggestion'?{getBoundingClientRect:()=>({width:304})}:null,
  scrollTo(options){this.scrollLeft=options.left;scrolls.push(options);this.onscroll?.();}});
 let rail=makeRail(),hub;
 const root={dataset:{renderedPage:'strategies'},querySelectorAll:selector=>selector==='[data-bh]'?buttons:[],querySelector:selector=>{
  if(selector==='[data-bh-recommendation-rail]')return rail;
  if(selector==='.bh-carousel-controls')return controls;
  return buttons.find(button=>selector===`[data-bh="${button.dataset.bh}"]`||selector===`[data-bh="${button.dataset.bh}"][data-id="${button.dataset.id}"]`)||null;
 }};
 hub=createBotHub({w,root,desk:{syncStatus:()=>({}),readSnapshot:()=>trade},refresh:()=>{hub.render('strategies');hub.bind();},go:page=>routes.push(page),choose:()=>assert.fail('Browsing recommendations must not create a plan')});
 return {w,trade,root,hub,buttons,controls,scrolls,routes,focus,get rail(){return rail;},replaceRail(){rail.isConnected=false;rail=makeRail();return rail;}};
}
test('recommendation rail supports page arrows, Home/End, and child controls without changing trading state',async()=>{
 const h=recommendationRailHarness(),before=JSON.stringify({w:h.w,trade:h.trade});h.hub.bind();
 assert.equal(h.buttons[0].disabled,true);assert.equal(h.buttons[1].disabled,false);assert.equal(h.controls.hidden,false);
 await h.buttons[1].onclick();assert.equal(h.rail.scrollLeft,960);
 await h.buttons[1].onclick();assert.equal(h.rail.scrollLeft,1600);assert.equal(h.buttons[1].disabled,true);
 await h.buttons[0].onclick();assert.equal(h.rail.scrollLeft,640);
 let prevented=0;
 h.rail.onkeydown({target:h.rail,key:'Home',preventDefault:()=>prevented++});assert.equal(h.rail.scrollLeft,0);
 h.rail.onkeydown({target:h.rail,key:'End',preventDefault:()=>prevented++});assert.equal(h.rail.scrollLeft,1600);
 h.rail.onkeydown({target:h.buttons[0],key:'ArrowLeft',preventDefault:()=>assert.fail('Child controls retain their own keyboard behavior')});
 assert.equal(h.rail.scrollLeft,1600);assert.equal(prevented,2);
 assert.equal(JSON.stringify({w:h.w,trade:h.trade}),before);assert.deepEqual(h.routes,[]);
});
test('recommendation rail honors both application and system reduced-motion preferences',async()=>{
 const oldDocument=globalThis.document,oldMedia=globalThis.matchMedia;
 try{
  for(const [app,system,expected] of [[false,false,'smooth'],[true,false,'auto'],[false,true,'auto']]){
   globalThis.document={documentElement:{dataset:{reducedMotion:String(app)}}};globalThis.matchMedia=()=>({matches:system});
   const h=recommendationRailHarness();h.hub.bind();await h.buttons[1].onclick();assert.equal(h.scrolls[0].behavior,expected);
  }
 }finally{if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;if(oldMedia===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=oldMedia;}
});
test('recommendation rail restores its position, resets on filtering and releases resize observers',async()=>{
 const oldResize=globalThis.ResizeObserver,oldFrame=globalThis.requestAnimationFrame,observers=[];
 try{
  globalThis.ResizeObserver=class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}};
  globalThis.requestAnimationFrame=callback=>callback();
  const h=recommendationRailHarness();h.hub.bind();h.rail.scrollLeft=640;h.rail.onscroll();
  const oldRail=h.rail;h.hub.render('strategies');assert.equal(observers[0].disconnected,true);
  h.replaceRail();h.hub.bind();assert.equal(h.rail.scrollLeft,640);
  oldRail.scrollLeft=0;oldRail.onscroll();h.hub.render('strategies');h.hub.bind();assert.equal(h.rail.scrollLeft,640);
  await h.buttons[2].onclick();assert.equal(h.rail.scrollLeft,0);assert.equal(h.focus.at(-1),'recommendation-venue');
  h.rail.clientWidth=h.rail.scrollWidth;observers.at(-1).callback();assert.equal(h.controls.hidden,true);assert.equal(h.rail.tabIndex,-1);
  h.rail.clientWidth=944;observers.at(-1).callback();assert.equal(h.controls.hidden,false);assert.equal(h.rail.tabIndex,0);
  h.hub.render('advisor');assert.equal(observers.at(-1).disconnected,true);
 }finally{if(oldResize===undefined)delete globalThis.ResizeObserver;else globalThis.ResizeObserver=oldResize;globalThis.requestAnimationFrame=oldFrame;}
});
test('strategy screens omit the retired questionnaire without changing saved account state',async()=>{
 const h=recommendationRailHarness(),before=JSON.stringify({w:h.w,trade:h.trade});
 const html=h.hub.render('strategies'),body=html.match(/<button[^>]+data-bh="advisor"[^>]*>([\s\S]*?)<\/button>/)?.[1];
 assert.equal(body,undefined);assert.doesNotMatch(html,/5 问选 Agent|5-question guide/);
 const header=html.match(/<header class="bh-overview-hero[^>]*>([\s\S]*?)<\/header>/)?.[1];
 assert.ok(header);assert.doesNotMatch(header,/data-bh="advisor"/);
 assert.doesNotMatch(h.hub.render('execution'),/data-bh="advisor"/);
 h.hub.bind();await h.buttons[4].onclick();assert.deepEqual(h.routes,['advisor']);assert.equal(JSON.stringify({w:h.w,trade:h.trade}),before);
});
test('template support, type and tracking filters compose and clear without authorizing a run',async t=>{
 const oldFrame=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=fn=>fn();t.after(()=>{if(oldFrame===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=oldFrame;});
 const w={s:{botTrackedTypes:['S02','S03']}},trade={botBook:{runs:[]}},before=JSON.stringify({w,trade});
 const buttons=['ready-only','tracked-only','category','reset'].map(bh=>({dataset:{bh,id:bh==='category'?'onchain':''}})),field={dataset:{bhSelect:'group'},value:'all'};
 const root={dataset:{renderedPage:'strategies'},querySelector:()=>null,querySelectorAll:s=>s==='[data-bh]'?buttons:s==='[data-bh-select]'?[field]:[]};
 const hub=createBotHub({w,desk:{syncStatus:()=>({scope:{accountId:'SIM-01',environment:'DEMO'}}),readSnapshot:()=>trade},root,refresh(){}});hub.bind();
 const html=()=>hub.render('strategies'),ids=()=>[...html().matchAll(/data-bot-strategy="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(ids().length,18);field.value='trend';field.onchange();const trend=ids();assert.ok(trend.includes('S03'));
 await buttons[0].onclick();assert.deepEqual(ids(),[]);assert.match(html(),/data-bh="reset"/);assert.match(html(),/bh-result-count">0</);
 await buttons[0].onclick();assert.deepEqual(ids(),trend,'turning support off restores the selected strategy type');
 field.value='all';field.onchange();await buttons[1].onclick();await buttons[0].onclick();assert.deepEqual(ids(),['S02']);
 await buttons[2].onclick();assert.deepEqual(ids(),[],'market tabs keep active filters instead of silently resetting them');
 await buttons[3].onclick();assert.ok(ids().length);assert.match(html(),/data-bh="ready-only"[^>]*aria-pressed="false"/);assert.match(html(),/data-bh="tracked-only"[^>]*aria-pressed="false"/);
 assert.equal(JSON.stringify({w,trade}),before);
});
test('guide focus intent follows actual root route changes, including pages that skip hub.render',async()=>{
 const oldFrame=globalThis.requestAnimationFrame,oldObserver=globalThis.MutationObserver,frames=[],observers=[];
 try{
  globalThis.requestAnimationFrame=callback=>frames.push(callback);
  globalThis.MutationObserver=class{constructor(callback){this.callback=callback;observers.push(this);}observe(node,options){this.node=node;this.options=options;}disconnect(){this.disconnected=true;}};
  const h=recommendationRailHarness();h.hub.bind();await h.buttons[4].onclick();
  assert.deepEqual(observers[0].options,{attributes:true,attributeFilter:['data-rendered-page']});assert.equal(observers[0].node,h.root);
  h.root.dataset.renderedPage='advisor';h.hub.render('advisor');observers[0].callback();
  // Assistant bypasses business.render and hub.render in the real product route.
  h.root.dataset.renderedPage='assistant';observers[0].callback();assert.equal(observers[0].disconnected,true);
  h.root.dataset.renderedPage='strategies';h.hub.render('strategies');h.hub.bind();assert.equal(frames.length,0);assert.deepEqual(h.focus,[]);
  await h.buttons[4].onclick();h.root.dataset.renderedPage='advisor';h.hub.render('advisor');observers[1].callback();
  h.root.dataset.renderedPage='strategies';h.hub.render('strategies');h.hub.bind();assert.equal(observers[1].disconnected,true);
  frames.shift()();assert.equal(h.focus.at(-1),'advisor');assert.equal(frames.length,0);assert.equal(observers.length,2);
 }finally{globalThis.requestAnimationFrame=oldFrame;if(oldObserver===undefined)delete globalThis.MutationObserver;else globalThis.MutationObserver=oldObserver;}
});


test('overview activity uses the selected scope and retains original run links',()=>{
 const trade={botBook:{runs:[run('BOT-01','running',{environment:'DEMO',initialAllocation:300,orders:[]})]}};
 const before=JSON.stringify(trade),html=renderBotOverview({w:{s:{}},trade,activityMetric:'allocation'});
 assert.match(html,/data-sat-state="ready"/);assert.match(html,/runId=BOT-01/);
 assert.match(html,/data-sat-metric="allocation"[^>]*aria-selected="true"/);
 assert.match(renderBotOverview({w:{s:{}},trade,accountId:'SIM-02'}),/data-sat-state="unavailable"/);
 assert.match(renderBotOverview({w:{s:{}},trade,environment:'LIVE'}),/data-sat-state="unavailable"/);
 assert.equal(JSON.stringify(trade),before);
});

test('dynamic picks keep the latest source revision, remove expired or undated signals, and never change the input',()=>{
 const first={id:'old',strategy:'S03',sourceType:'research',sourceId:'r-BTC',market:'BTC/USDT',asOf:10,source:{instrument:{}}},latest={...first,id:'latest',asOf:20,sourceRevision:2};
 const rows=[first,latest,{...first,id:'expired',sourceId:'expired',freshness:'expired'},{...first,id:'undated',sourceType:'signal',sourceId:'undated'},{...first,id:'unknown-strategy',strategy:'missing'}],before=JSON.stringify(rows);
 assert.deepEqual(recommendationItems(rows).map(r=>r.id),['latest']);assert.equal(recommendationKey(first),recommendationKey(latest));assert.equal(JSON.stringify(rows),before);
 for(const count of [0,1,2,3,7,12]){const picks=Array.from({length:count},(_,i)=>({...latest,id:'pick-'+i,sourceId:'source-'+i}));const html=renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}},recommendations:picks});assert.equal((html.match(/data-recommendation=/g)||[]).length,count);assert.equal(html.includes('data-bh="recommendation-next"'),count>1);}
});
function carouselFixture(t,{count=3,state={},reduced=false}={}){
 const original={document:globalThis.document,matchMedia:globalThis.matchMedia,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,IntersectionObserver:globalThis.IntersectionObserver,now:Date.now};
 const timers=new Map(),listeners=new Map(),mediaListeners=new Map();let serial=0,now=0,intersection;
 globalThis.IntersectionObserver=class{constructor(cb){intersection=cb;}observe(){}disconnect(){}};
 Date.now=()=>now;globalThis.setTimeout=(fn,delay)=>{const id=++serial;timers.set(id,{fn,at:now+delay});return id;};globalThis.clearTimeout=id=>timers.delete(id);
 const classList=()=>{const set=new Set();return {add:x=>set.add(x),toggle:(x,on)=>on?set.add(x):set.delete(x),contains:x=>set.has(x)};};
 const cards=Array.from({length:count},(_,i)=>({dataset:{pickKey:'key-'+i},style:{setProperty(k,v){this[k]=v;}},attrs:{},classList:classList(),offsetHeight:400,buttons:[{},{}],setAttribute(k,v){this.attrs[k]=v;},querySelectorAll(){return this.buttons;}}));
 const doc={documentElement:{dataset:{}},visibilityState:'visible',activeElement:null,querySelector:()=>null,addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k)};
 const media={matches:reduced,addEventListener:(k,f)=>mediaListeners.set(k,f),removeEventListener:k=>mediaListeners.delete(k)};
 const rail={clientWidth:1084,style:{},dataset:{},classList:classList(),isConnected:true,getBoundingClientRect:()=>({width:1084}),querySelectorAll:()=>cards,matches:()=>false,contains:x=>x===rail||cards.some(c=>c.buttons.includes(x)),setPointerCapture(){},focus(){doc.activeElement=rail;rail.onfocusin();}};
 const output={},pause={setAttribute(k,v){this[k]=v;}},root={querySelector:s=>s==='[data-bh-recommendation-rail]'?rail:s==='[data-pick-count]'?output:s==='[data-bh="recommendation-pause"]'?pause:null};
 globalThis.document=doc;globalThis.matchMedia=()=>media;
 let controller=mountRecommendationCarousel(root,state);
 const tick=ms=>{const target=now+ms;let next;while((next=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0])){const [id,t]=next;timers.delete(id);now=t.at;t.fn();}now=target;};
 t.after(()=>{controller?.dispose();for(const [key,value]of Object.entries(original)){if(key==='now')Date.now=value;else if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 const target={closest:()=>null};
 return {root,rail,cards,doc,media,state,output,pause,tick,timers,listeners,mediaListeners,target,intersect:visible=>intersection([{isIntersecting:visible}]),get controller(){return controller;},remount(){controller.dispose();controller=mountRecommendationCarousel(root,state);return controller;}};
}
test('the carousel pauses for reading, focus, manual pause, background and reduced motion, then cleans up',t=>{
 const f=carouselFixture(t);assert.equal(f.output.textContent,'1 / 3');assert.equal(f.cards[0].buttons[0].tabIndex,0);assert.equal(f.cards[1].buttons[0].tabIndex,0);
 f.tick(11999);assert.equal(f.state.index,0,'each pick stays visible for twelve seconds');f.tick(1);assert.equal(f.state.index,1);f.tick(700);assert.equal(f.rail.dataset.interacting,undefined);
 f.rail.onmouseenter();f.tick(24000);assert.equal(f.state.index,1);f.rail.onmouseleave();f.tick(12000);assert.equal(f.state.index,2);
 f.controller.toggle();f.tick(24000);assert.equal(f.state.index,2);assert.equal(f.pause['aria-pressed'],'true');f.controller.toggle();
 f.rail.onfocusin();f.tick(24000);assert.equal(f.state.index,2);f.rail.onfocusout({relatedTarget:null});
 f.doc.visibilityState='hidden';f.listeners.get('visibilitychange')();f.tick(24000);assert.equal(f.state.index,2);f.doc.visibilityState='visible';f.listeners.get('visibilitychange')();
 f.media.matches=true;f.mediaListeners.get('change')();f.tick(24000);assert.equal(f.state.index,2);assert.equal(f.pause.hidden,true);
 f.media.matches=false;f.mediaListeners.get('change')();f.tick(12000);assert.equal(f.state.index,0);f.controller.dispose();assert.equal(f.timers.size,0);assert.equal(f.listeners.size,0);assert.equal(f.mediaListeners.size,0);
});
test('keyboard and touch navigation wrap, preserve the selected source on refresh and leave buttons alone',t=>{
 const f=carouselFixture(t,{count:7});let prevented=0;
 f.rail.onkeydown({key:'End',target:f.target,preventDefault:()=>prevented++});assert.equal(f.state.index,6);assert.equal(f.cards[6].attrs['aria-current'],'true');
 f.rail.onkeydown({key:'ArrowRight',target:f.target,preventDefault:()=>prevented++});assert.equal(f.state.index,0);assert.equal(prevented,2);
 f.controller.step(1);const key=f.state.key;f.cards.reverse();f.remount();assert.equal(f.cards[f.state.index].dataset.pickKey,key);
 const start=f.state.index;
 f.rail.onpointerdown({button:0,target:{closest:()=>({})},pointerId:1,clientX:200,clientY:10});assert.equal(f.rail.dataset.interacting,'true');f.rail.onpointerup({type:'pointerup',clientX:200,clientY:10});assert.equal(f.rail.dataset.interacting,undefined);
 f.rail.onpointerdown({button:0,target:f.target,pointerId:1,clientX:200,clientY:10});assert.equal(f.rail.dataset.interacting,'true');f.rail.onpointerup({type:'pointerup',clientX:200,clientY:100});assert.equal(f.state.index,start,'vertical page scrolling is not a card change');
 f.rail.onpointerdown({button:0,target:f.target,pointerId:1,clientX:200,clientY:10});f.rail.onpointerup({type:'pointerup',clientX:100,clientY:12});assert.equal(f.state.index,(start+1)%7);f.tick(700);assert.equal(f.rail.dataset.interacting,undefined);
 f.rail.onpointerdown({button:0,target:f.target,pointerId:1,clientX:200,clientY:10});f.rail.onpointercancel({type:'pointercancel'});assert.equal(f.rail.dataset.interacting,undefined);
});
test('single-item and reduced-motion carousels do not start autoplay',t=>{
 const f=carouselFixture(t,{count:1,reduced:true});f.tick(60000);assert.equal(f.state.index,0);assert.equal(f.timers.size,0);assert.equal(f.pause.hidden,true);assert.equal(f.rail.classList.contains('is-reduced'),true);
});

test('routine feed refreshes preserve the carousel deadline while off-screen items stay paused',t=>{
 const f=carouselFixture(t);const deadline=f.state.nextAt;
 assert.equal(f.rail.dataset.interacting,undefined,'mounting the feed is not a carousel transition');
 for(let i=0;i<6;i++){f.tick(1000);f.remount();f.intersect(true);assert.equal(f.state.nextAt,deadline);assert.equal(f.rail.dataset.interacting,undefined,'a feed refresh must not replay the entrance transition');}
 f.tick(5999);assert.equal(f.state.index,0);f.tick(1);assert.equal(f.state.index,1,'a periodically rendered feed still rotates after twelve seconds');
 f.intersect(false);f.tick(20000);assert.equal(f.state.index,1);f.intersect(true);f.tick(12000);assert.equal(f.state.index,2);
});
test('native grid and scaling picks use the existing tick cadence rather than an unrelated candle period',()=>{
 for(const [strategy,variant,label]of [['S01','S01-SIM',/逐笔 · 区间触发|Ticks · grid levels/],['S02','S02-SIM',/逐笔 · 价格偏离|Ticks · deviation/]]){
  const row={id:'cadence',strategy,variant,asset:'BTC',market:'BTC/USDT'},html=renderBotOverview({w:{s:{}},trade:{botBook:{runs:[]}},recommendations:[row]}).split('data-recommendation="cadence"')[1].split('</article>')[0];
  assert.match(html,label);assert.doesNotMatch(html,/1h \/|5m \/ 1h/);
 }
});
test('a detail modal opened before the next tick prevents the carousel from switching its source',t=>{
 const f=carouselFixture(t);let open=false;f.doc.querySelector=()=>open?{}:null;f.tick(11900);open=true;f.tick(1000);assert.equal(f.state.index,0);
 open=false;f.remount();f.tick(12000);assert.equal(f.state.index,1);
});
test('a held pointer pauses rotation and a retargeted card tap selects the card without relying on a bubbled click',t=>{
 const f=carouselFixture(t),target={closest:s=>s==='[data-recommendation]'?f.cards[2]:null};
 f.rail.onpointerdown({button:0,target,pointerId:1,clientX:200,clientY:10});f.tick(24000);assert.equal(f.state.index,0,'touch-and-hold must not rotate');
 f.rail.onpointerup({type:'pointerup',target:f.rail,clientX:201,clientY:10});assert.equal(f.state.index,2,'pointer capture may retarget the click to the rail');
});

for(const origin of ['button','span','svg'])test(`a configuration ${origin} press at the autoplay deadline stays on its source and never becomes a swipe`,t=>{
 const f=carouselFixture(t),button=f.cards[0].buttons[1];button.tagName='BUTTON';button.closest=selector=>selector.split(',').includes('button')?button:selector==='[data-recommendation]'?f.cards[0]:null;
 const target=origin==='button'?button:{tagName:origin.toUpperCase(),parentElement:button,closest:selector=>button.closest(selector)};
 f.tick(11999);f.rail.onpointerdown({button:0,target,pointerId:1,clientX:200,clientY:10});f.tick(24000);
 assert.equal(f.state.index,0,'a pressed configuration button must pause autoplay before focus is assigned');
 f.rail.onpointerup({type:'pointerup',target,clientX:100,clientY:10});assert.equal(f.state.index,0,'a gesture that began on a control must not navigate the carousel');
 f.rail.onclick({target});assert.equal(f.state.index,0,'the bubbled button click must not select another card');
 f.tick(11999);assert.equal(f.state.index,0);f.tick(1);assert.equal(f.state.index,1,'autoplay resumes only after a fresh reading interval');
});
test('visible card actions stay accessible, and footer whitespace and control arrow keys never rotate the carousel',t=>{
 const f=carouselFixture(t),footer={},target={closest(selector){if(selector.split(',').includes('footer'))return footer;return selector==='[data-recommendation]'?f.cards[2]:null;}};
 assert.equal(f.cards[2].attrs['aria-hidden'],'false','visible neighboring actions must not be hidden from assistive technology');assert.equal(f.cards[2].buttons[0].tabIndex,0);
 f.rail.onpointerdown({button:0,target,pointerId:1,clientX:200,clientY:10});f.rail.onpointerup({type:'pointerup',target,clientX:201,clientY:10});f.rail.onclick({target});assert.equal(f.state.index,0,'the footer is an action area, not a card selection target');
 const button=f.cards[0].buttons[1],buttonTarget={closest:selector=>selector.split(',').includes('button')?button:null};
 f.rail.onkeydown({key:'ArrowRight',target:buttonTarget,preventDefault:()=>assert.fail('a card action retains its keyboard event')});assert.equal(f.state.index,0);
 f.rail.clientWidth=320;f.remount();assert.equal(f.cards[2].attrs['aria-hidden'],'true');assert.equal(f.cards[2].buttons[0].tabIndex,-1,'hidden mobile neighbors stay out of the tab order');
 f.rail.ownerDocument={defaultView:{innerWidth:1024}};f.rail.clientWidth=700;f.remount();assert.equal(f.cards[2].attrs['aria-hidden'],'false','CSS uses the page viewport, not the rail width, to hide mobile neighbors');
});
test('canceling or leaving a pressed configuration action releases its refresh and autoplay lock',t=>{
 const f=carouselFixture(t),target={closest:selector=>selector.split(',').includes('button')?f.cards[0].buttons[1]:null};let captured=0;f.rail.setPointerCapture=()=>captured++;
 f.rail.onpointerdown({button:0,target,pointerId:1,clientX:200,clientY:10});f.rail.onpointercancel({type:'pointercancel'});assert.equal(f.rail.dataset.interacting,undefined);f.tick(12000);assert.equal(f.state.index,1);
 f.rail.onpointerdown({button:0,target,pointerId:1,clientX:200,clientY:10});f.rail.onmouseleave();assert.equal(f.rail.dataset.interacting,undefined);f.tick(12000);assert.equal(f.state.index,2);assert.equal(captured,0,'configuration actions must retain their native pointer target');
});
test('a visible neighboring configuration button opens exactly its own source once without selecting the card',async t=>{
 const f=carouselFixture(t);f.controller.dispose();
 const row={id:'research-ETH',strategy:'RX03-S',variant:'baseline',asset:'ETH',market:'ETH/USDT',status:'research',canAdopt:true,freshness:'unknown',source:{instrument:{symbol:'ETH',market:'ETH/USDT'}}},button=f.cards[1].buttons[1],opened=[];
 button.dataset={bh:'recommendation',id:row.id};f.root.dataset={renderedPage:'strategies'};f.root.querySelectorAll=selector=>selector==='[data-bh]'?[button]:[];
 const hub=createBotHub({w:{s:{}},desk:{},root:f.root,recommendations:()=>[row],chooseRecommendation:id=>{opened.push(id);return true;},refresh:()=>assert.fail('a valid button must navigate rather than refreshing the deck')});
 hub.bind();try{
 const target={closest:selector=>selector.split(',').includes('button')?button:selector==='[data-recommendation]'?f.cards[1]:null};
 f.tick(11999);f.rail.onpointerdown({button:0,target,pointerId:1,clientX:200,clientY:10});f.tick(2);f.rail.onpointerup({type:'pointerup',target,clientX:200,clientY:10});await button.onclick();f.rail.onclick({target});
 assert.deepEqual(opened,[row.id]);assert.equal(f.output.textContent,'1 / 3','the button must not first turn its neighboring card into the active card');
 }finally{hub.render('workbench');}
});

test('returning from a source-bound configuration grants reading time before the next carousel advance',async t=>{
 const f=carouselFixture(t),original=globalThis.requestAnimationFrame,frames=[];f.controller.dispose();globalThis.requestAnimationFrame=fn=>frames.push(fn);t.after(()=>{if(original===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=original;});
 const row={id:'research',strategy:'RX03-S',variant:'baseline',asset:'ETH',market:'ETH/USDT',status:'research',canAdopt:true,freshness:'unknown',source:{instrument:{market:'ETH/USDT'}}};
 const button={dataset:{bh:'recommendation',id:row.id},focus(){f.rail.onfocusin();}},trade={botBook:{runs:[]}};let back,hub;
 f.root.dataset={renderedPage:'strategies'};f.root.querySelectorAll=s=>s==='[data-bh]'||s==='[data-bh="recommendation"]'?[button]:[];
 hub=createBotHub({w:{s:{}},desk:{syncStatus:()=>({}),readSnapshot:()=>trade},root:f.root,recommendations:()=>[row],refresh(){hub.render('strategies');hub.bind();},chooseRecommendation:(id,onBack)=>{back=onBack;return true;}});
 hub.render('strategies');hub.bind();await button.onclick();hub.render('workbench');f.tick(20000);back();f.tick(0);assert.equal(f.output.textContent,'1 / 3','return must not immediately rotate away from the chosen source');
 for(const frame of frames)frame();f.tick(12000);assert.equal(f.output.textContent,'1 / 3','restored source focus pauses reading');hub.render('workbench');
});
