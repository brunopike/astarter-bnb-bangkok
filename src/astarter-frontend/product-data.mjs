import {routeSearch} from './site-routes.mjs';
import {positionValue} from './order-markets.mjs';
import {syntheticPrice} from './research-state.mjs';
export const BRAIN_PAGE_NAME=Object.freeze(['链上深脑','Deep Brain']);
export const PAGES=[['lite','Lite','◎'],['brain',BRAIN_PAGE_NAME[0],'◎'],['watchlist','我的追踪','☆'],['assistant','交易助手','◌'],['advisor','帮我选策略','◇'],['copy-trading','聪明钱跟随','↗'],['contributions','我的贡献','✧'],['signals','AI 信号','↗'],['workbench','AI 交易','◎'],['markets','市场行情','⌁'],['tracking','AI 与链上追踪','↗'],['intelligence','新闻舆情','◷'],['social','社媒动态','◌'],['derivatives','合约与清算','⌁'],['etf','ETF 资金','▥'],['strategies','策略 Agent','▦'],['logs','交易记录','≡'],['assets','资产信息','◫'],['setup','初始设定','⚙'],['inbox','待办事项','!'],['mandate','交易方式','◇'],['opportunities','机会发现','↗'],['my-strategies','我的策略','▦'],['validation','策略检查','✓'],['execution','我的 Agent','▶'],['risk','Astarter 风控策略','◇'],['plans','订阅','◉'],['topup','积分充值','◉'],['staking','质押奖励','◇'],['billing','账户账单','≡'],['usage','用量','◉'],['profile','个人中心','○'],['settings','连接与设置','⚙']];
export const INTELLIGENCE=[
{id:'macro-01',source:'macro',symbol:'BTC',title:'利率决议窗口临近',time:'14:30',type:'宏观事件',value:'90',unit:'分钟',decision:'conflict',reason:'模拟高影响事件窗口内，新增风险需要等待重新核验。',detail:'演示经济日历：利率决议前后可能放大波动。事件时间为固定剧本，不是真实经济日历。',role:0},
{id:'social-01',source:'social',symbol:'ETH',title:'讨论升温，原始消息尚待确认',time:'14:22',type:'社交舆情',value:'68',unit:'热度',decision:'missing',reason:'传播热度不能验证消息真实性；缺少原始出处。',detail:'示例讨论量上升 26%，正向占比 61%。重复传播需去重，先核验来源，再判断价格影响。',role:3},
{id:'chain-01',source:'chain',symbol:'BTC',title:'监测地址出现集中转账',time:'14:18',type:'链上异动',value:'3',unit:'笔',decision:'context',reason:'地址转账保留为旁证；尚不能归因为买入、卖出或交易所充值。',detail:'演示地址组转出 240 BTC；所有者、目的地用途与交易意图未知，无真实交易哈希。',role:16},
{id:'ai-01',source:'trend',symbol:'SOL',title:'资金与价格出现一致性线索',time:'14:12',type:'首次发现',value:'72',unit:'指数',decision:'retain',reason:'合成多维条件一致，保留观察，仍不构成交易授权。',detail:'量能、价差与价格结构的预设观察条件同时满足，等待风险与执行核验。',role:1},
{id:'macro-02',source:'macro',symbol:'BTC',title:'美元与风险资产相关性观察',time:'14:05',type:'宏观背景',value:'2',unit:'项',decision:'context',reason:'宏观背景仅作解释变量，不单独触发下单。',detail:'合成美元指数与风险资产呈反向变化。相关性不是因果关系。',role:0},
{id:'social-02',source:'social',symbol:'SOL',title:'重复消息去重后热度回落',time:'13:58',type:'舆情核验',value:'42',unit:'热度',decision:'context',reason:'去重后的讨论强度保留作旁证。',detail:'示例采集 120 条讨论，其中 78 条重复；没有调用 X 或任何社交 API。',role:3},
{id:'chain-02',source:'chain',symbol:'ETH',title:'合约交互频次上升',time:'13:46',type:'链上活动',value:'12',unit:'次',decision:'context',reason:'合约调用活跃不等于资金净流入，需核对执行类型。',detail:'示例地址组在观察窗口出现 12 次调用，不推断独立用户数或真实需求。',role:16},
{id:'ai-02',source:'volatility',symbol:'BTC',title:'波动升高，保护条件待复核',time:'13:31',type:'保护提示',value:'4.2',unit:'%',decision:'conflict',reason:'模拟波动阈值越界，先复核保护条件。',detail:'预设异常样例用于演示暂停新增风险；未分析实际市场。',role:5},
];
export const STRATEGIES=[['S01','震荡现货网格','区间分层 · 库存上限'],['S02','有限层数马丁','层数上限 · 总预算'],['S03','均线 + RSI','收盘确认 · 趋势过滤'],['S04','缠论第三类买点','结构确认 · 级别核验'],['S05','日内剥头皮','盘口深度 · 执行时限'],['S06','波浪突破候选','主备计数 · 失效线'],['S07','威科夫价量','区间测试 · 量价确认'],['S08','裸 K 突破回测','突破回测 · 收盘确认'],['S09','LP 池间价差套利','成本核验 · 原子执行'],['S00','H5 结构与量价组合','PA / VSA · 独立风控']];
export const ASSETS=[['BTC','Bitcoin','Crypto','USDT',81230],['ETH','Ethereum','Crypto','USDT',3180],['SOL','Solana','Crypto','USDT',184],['SPX','标普 500','TradFi','点',5840],['NDX','纳斯达克 100','TradFi','点',20480],['XAU','黄金现货','TradFi','USD/盎司',2720],['DXY','美元指数','TradFi','点',104.2],['US10Y','美国十年国债','TradFi','%',4.2]];
export function marketSeries(symbol,period='1H'){
 const row=ASSETS.find(a=>a[0]===symbol)||ASSETS[0],scale=period==='1D'?3:period==='4H'?2:1;
 const baseline=Array.from({length:60},(_,i)=>row[2]==='Crypto'?syntheticPrice(row[0]+'/USDT',(i-59)*scale):row[4]*(1+Math.sin(i*.19)*.001+Math.sin(i*.47)*.0004+i*.000035*scale));
 // Deterministic synthetic intrawindow variation; keep the endpoint used by the demo quote.
 let seed=[...symbol+period].reduce((s,c)=>Math.imul(s,31)+c.charCodeAt(0),17)>>>0,walk=0;
 const path=baseline.map(()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;walk+=(seed/4294967296-.48)*row[4]*.0011*Math.sqrt(scale);return walk;});
 return baseline.map((v,i)=>v+path[i]-path[0]-(path.at(-1)-path[0])*i/59);
}
export function accountOrders(d){
 const accountId=d.accountSummary?.accountId||d.accountId||'SIM-01';
 const native=(d.botBook?.runs||[]).filter(run=>run.plan?.executionRoute?.accountId===accountId).flatMap(run=>(run.orders||[]).filter(order=>order.runId===run.id&&order.accountId===accountId).map(order=>({...order,strategy:run.plan.strategy})));
 const orders=[...(d.orders||[]),...native];
 return [...new Map(orders.map(order=>[[order.accountId||accountId,order.runId,order.id].join(':'),order])).values()];
}
export function portfolio(d){
 const position=d.position,bot=d.botSummary||{},legacyHeld=(d.positions||[position]).reduce((sum,p)=>sum+positionValue(p),0),botCash=bot.cash||0,cash=d.cash+botCash,held=legacyHeld+(bot.inventoryValue||0),equity=d.cash+legacyHeld+(bot.equity||0);
 const accountId=d.accountSummary?.accountId||d.accountId||'SIM-01';
 const native=(d.botBook?.runs||[]).filter(run=>run.plan?.executionRoute?.accountId===accountId&&run.quantity>0).map(run=>({runId:run.id,accountId,market:run.plan.market,qty:run.quantity,price:run.costBasis/run.quantity,markPrice:run.markPrice,inventoryValue:run.inventoryValue,marketType:'SPOT',venue:'Binance',venueType:'CEX',nativeBot:true}));
 const positions=[...(d.positions||[position].filter(Boolean)),...native];
 const orderReserved=(d.flow?.reservations||[]).filter(row=>row.state==='HELD'&&['USD','USDT','USDC'].includes(row.unit)).reduce((sum,row)=>sum+Number(row.amount),0);
 // BOT budgets already left d.cash; the shared account summary also covers legacy strategy budgets.
 const freeCash=d.accountSummary?.available??Math.max(0,d.cash-orderReserved),reservedCash=Math.max(0,cash-freeCash),orders=accountOrders(d);
 return {cash,freeCash,reservedCash,botCash,held,equity,pnl:equity-10000,fees:d.totalFees+(bot.fees||0),position,positions,orders:orders.length,filled:orders.filter(o=>o.filled>0).length};
}
export function currentIntelligenceRoute(search){
 const params=new URLSearchParams(search);
 if(params.get('page')!=='intelligence'||(params.get('data')!=='demo'&&!/^n\d+$/.test(params.get('story')||'')))return null;
 params.delete('data');
 params.delete('story');
 return '?'+params.toString();
}
export function watchlistRoute(search){
 const params=new URLSearchParams(search),page=params.get('page');
 if(page!=='watchlist'&&!(page==='markets'&&params.get('view')==='watchlist'))return null;
 params.set('page',page==='watchlist'?'workbench':'markets');
 if(params.get('view')==='watchlist')params.delete('view');
 return '?'+params;
}
export function wealthRoute(search){
 const params=new URLSearchParams(search);
 if(params.get('page')!=='wealth')return null;
 params.set('page','workbench');
 params.delete('strategy');
 params.delete('asset');
 return '?'+params.toString();
}
export function routePage(search){
 const params=new URLSearchParams(search),page=params.get('page');
 if(!page){
  const workbenchLink=['scene','research','localSim','asset','task'].some(key=>params.has(key));
  return workbenchLink?'workbench':'brain';
 }
 if(page==='wealth')return 'workbench';
 if(page==='staking')return 'plans';
 if(page==='my-strategies')return 'execution';
 return PAGES.some(([id])=>id===page)?page:'workbench';
}
export const TRADING_TABS=[
 {id:'strategies',zh:'策略 Agent',en:'Strategy Agents',pages:['strategies','advisor','copy-trading','contributions']},
 {id:'execution',zh:'我的 Agent',en:'My Agents',pages:['execution','my-strategies','validation','inbox','assets','risk','mandate']}
];
export const TRADING_PAGES=TRADING_TABS.flatMap(item=>item.pages);
export const tradingSection=page=>TRADING_TABS.find(item=>item.pages.includes(page))?.id||null;
export const MOBILE_DOCK=[
 {id:'brain',home:'brain',zh:BRAIN_PAGE_NAME[0],en:BRAIN_PAGE_NAME[1],pages:['brain']},
 {id:'workbench',home:'workbench',zh:'AI 交易',en:'LensWave',ja:'AI',ko:'AI',vi:'AI',es:'IA',fr:'IA',ru:'ИИ',pages:['workbench']},
 {id:'execution',home:'strategies',zh:'策略交易',en:'Agents',ja:'取引',ko:'거래',vi:'Giao dịch',es:'Operar',fr:'Trade',ru:'Трейд',pages:TRADING_PAGES},
 {id:'signals',home:'signals',zh:'智选信号',en:'Signals',ja:'シグナル',ko:'신호',vi:'Tín hiệu',es:'Señales',fr:'Signaux',ru:'Сигналы',pages:['signals','opportunities']},
 {id:'data',home:'markets',zh:'数据中心',en:'Data',ja:'データ',ko:'데이터',vi:'Dữ liệu',es:'Datos',fr:'Données',ru:'Данные',pages:['markets','tracking','intelligence','social','derivatives','etf']}
];
export const ASSISTANT_NAV={id:'assistant',home:'assistant',zh:'AI 助手',en:'Chat',ja:'チャット',ko:'채팅',vi:'Chat',es:'Chat',fr:'Chat',ru:'Чат',pages:['assistant']};
export const MOBILE_NAV=[...MOBILE_DOCK,ASSISTANT_NAV];
export const mobileNavSection=page=>MOBILE_NAV.find(item=>item.pages.includes(page))?.id||null;
export function restoreNavigationSearch(search,currentSearch){
 const target=new URLSearchParams(search),current=new URLSearchParams(currentSearch);
 const missing=['motion','look','lang'].filter(key=>current.has(key)&&!target.has(key));
 if(!missing.length)return search;
 for(const key of missing)target.set(key,current.get(key));
 return '?'+target.toString();
}
// Only a handoff from Deep Brain carries a research scope into its return link.
export function brainEntrySearch(origin=globalThis.history?.state?.brainReturn,current=routeSearch()){
 const source=new URLSearchParams(origin),here=new URLSearchParams(current);
 const target=new URLSearchParams({page:'brain',view:'cortexa'});
 if(source.get('page')==='brain'){
  const scope=source.get('scope');
  if(scope&&scope.length<=500)target.set('scope',scope);
 }
 const lang=here.get('lang')||source.get('lang');
 if(lang)target.set('lang',lang);
 return '?'+target.toString();
}
export function updateBrainEntry(link,origin,current){
 if(!link)return;
 const href=brainEntrySearch(origin,current);
 if(link.getAttribute('href')!==href)link.setAttribute('href',href);
}
export function createNavigationMemory(){
 const routes=new Map(),positions=new Map();
 return {
  remember(search,scrollTop=0){
   const page=routePage(search),section=mobileNavSection(page);
   positions.set(search,Math.max(0,Number(scrollTop)||0));
   if(section)routes.set(section,search);
  },
  target(section){return routes.get(section)||'?page='+(MOBILE_NAV.find(item=>item.id===section)?.home||TRADING_TABS.find(item=>item.id===section)?.id||(section==='data'?'markets':'signals'));},
  position(search){return positions.get(search)||0;}
 };
}
export function validateSetup(d){if(!['BTC/USDT','ETH/USDT','SOL/USDT'].includes(d.market))return '请选择受支持的模拟盘口';if(!['confirm','signal','auto','review'].includes(d.mode))return '请选择执行方式';if(!Number.isFinite(d.amount)||d.amount<10||d.amount>1000||!Number.isFinite(d.cap)||d.cap<d.amount||d.cap>3000)return '单笔 10–1,000 USDT，敞口上限须覆盖单笔且不超过 3,000';return null;}
export function armSources(model){model.sourceQueue=[{...INTELLIGENCE[4],at:9},{...INTELLIGENCE[5],at:6},{...INTELLIGENCE[2],at:10}];for(const role of [0,3,16])if(!model.config.actors.includes(role))model.additionalActors.push(role);model.holdUntil=Math.max(model.holdUntil,26);}
export function deliverSource(model,item){if(!model.config.actors.includes(item.role))model.additionalActors.push(item.role);model.completed=false;model.holdUntil=Math.max(model.holdUntil,model.elapsed+9);model.record(model.elapsed,item.role,12,item.title);Object.assign(model.events[0],{source:item.source,evidenceName:item.title,decision:item.decision,reason:item.reason,sourceId:item.id});}
export function tickSources(model){const ready=(model.sourceQueue||[]).filter(e=>model.elapsed>=e.at);model.sourceQueue=(model.sourceQueue||[]).filter(e=>model.elapsed<e.at);for(const e of ready)deliverSource(model,e);}

export function queueSource(model,item){model.sourceQueue=(model.sourceQueue||[]).filter(e=>e.source!==item.source);if(!model.config.actors.includes(item.role))model.additionalActors.push(item.role);model.sourceQueue.push({...item,at:item.source==='social'?6:item.source==='macro'?9:12});}


// Read-only, multi-asset observation fixtures. Choosing a chart never configures execution.
export function observationPrice(symbol,n){
 const a=ASSETS.find(a=>a[0]===symbol);if(!a)throw new Error('Unknown observation asset');
 if(a[2]==='Crypto')return syntheticPrice(symbol+'/USDT',n);
 const seed=ASSETS.indexOf(a)+1;
 return a[4]*(1+Math.sin(n*.047+seed)*.0018+Math.sin(n*.13+seed*.7)*.0007+n*.000008);
}
export function observationSnapshot(time=0){
 const n=Math.max(0,time)*2;
 return ASSETS.map(([symbol,name,domain,unit])=>{const values=Array.from({length:54},(_,i)=>observationPrice(symbol,n-162+i*162/53));return {symbol,name,domain,unit,price:observationPrice(symbol,n),change:(observationPrice(symbol,n)/values[0]-1)*100,values,normalized:values.map(v=>v/values[0]*100),mode:'simulation-only'};});
}
