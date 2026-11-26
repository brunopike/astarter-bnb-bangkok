import {seoLanguages,seoLanguage,previews} from './site-languages.mjs';
// Public URLs and search metadata for the Hackathon web application.
export const SITE_ORIGIN = 'https://demo.astarter.io';
const publicPages = [
 ['brain','/','Deep Brain','链上深脑','Explore the Cortexa research graph, follow the evidence behind a market observation and open its research notes.','探索 Cortexa 链上研究图谱，查看市场观察的证据来源与研究笔记。'],
 ['workbench','/lenswave','LensWave','AI 星谱 LensWave','Follow tracked assets through market research, evidence review and technical observations in the LensWave workspace.','在 LensWave 星谱工作台追踪标的，查看行情采集、证据核验和技术观察。'],
 ['strategies','/agents','Strategy Agents','策略 Agent','Browse trading strategy agents and inspect their logic, supported markets and risk settings.','浏览策略 Agent，了解策略逻辑、适用市场和风险设置。'],
 ['signals','/signals','Market Signals','智选信号','Explore market signals and filter observations by asset and status to review their supporting data.','按标的和状态筛选市场信号，查看观察记录与支持数据。'],
 ['opportunities','/opportunities','Market Opportunities','机会发现','Browse market opportunities and inspect the research behind each observation.','浏览市场机会，查看各项观察背后的研究依据。'],
 ['markets','/markets','Market Data','市场行情','Explore prices and market activity across crypto and traditional assets in the Astarter data center.','在 Astarter 数据中心查看加密与传统资产的价格及市场活动。'],
 ['tracking','/onchain','Onchain Tracking','AI 与链上追踪','Review onchain activity and exchange flows alongside the assets and sources covered by Astarter.','查看链上活动、交易所资金流及其覆盖的标的与来源。'],
 ['intelligence','/news','News & Sentiment','新闻舆情','Follow market news, the economic calendar and cross-market developments with source and publication details.','查看市场快讯、经济日历与跨市场动态，核对消息来源和发布时间。'],
 ['social','/social','Social Trends','社媒动态','Read selected market commentary and compare topic activity and trader rankings.','阅读精选市场评论，查看主题热度和交易员排行。'],
 ['derivatives','/derivatives','Derivatives & Liquidations','合约与清算','Explore derivatives data, funding rates and liquidation activity by asset and exchange.','按标的和交易所查看衍生品数据、资金费率和清算情况。'],
 ['etf','/etf-flows','ETF Fund Flows','ETF 资金','Compare Bitcoin and Ethereum ETF flows and review the fund-level data available for each reporting period.','比较比特币与以太坊 ETF 资金流，查看各报告期可用的逐基金数据。'],
];
const workspacePages = [
 ['lite','/lite','Lite Trading Desk','Lite 交易台'],
 ['assistant','/chat','AI Assistant','AI 助手'],['execution','/my-agents','My Agents','我的 Agent'],
 ['watchlist','/watchlist','Watchlist','我的追踪'],['advisor','/strategy-advisor','Strategy Advisor','策略选择'],
 ['copy-trading','/copy-trading','Copy Trading','聪明钱跟随'],['contributions','/contributions','My Contributions','我的贡献'],
 ['logs','/trade-history','Trade History','交易记录'],['assets','/portfolio','Account Assets','账户资产'],
 ['setup','/setup','Setup','初始设定'],['inbox','/inbox','Inbox','待办事项'],['mandate','/mandate','Trading Permissions','交易授权'],
 ['validation','/strategy-checks','Strategy Checks','策略检查'],['risk','/risk','Risk Settings','风控设置'],
 ['plans','/plans','Plans','订阅方案'],['topup','/credits','Top Up Credits','积分充值'],['billing','/billing','Billing','账户账单'],
 ['usage','/usage','Usage','用量'],['profile','/profile','Account Profile','个人中心'],['settings','/settings','Connections & Settings','连接与设置']
];
export const routes = [...publicPages,...workspacePages].map(([id,path,en,zh,descEn,descZh])=>({
 id,path,en,zh,descEn,descZh,indexable:Boolean(descEn)
}));
export const byId=new Map(routes.map(route=>[route.id,route]));
export const byPath=new Map(routes.map(route=>[route.path,route]));
const aliases=new Map([['wealth','workbench'],['my-strategies','execution'],['staking','plans']]);
const oldWorkbenchKeys=['scene','research','localSim','asset','task'];
export function resolveSiteRoute(url){
 const explicit=url.searchParams.get('page');
 if(explicit)return byId.get(aliases.get(explicit)||explicit);
 const path=url.pathname.replace(/\/+$/,'')||'/';
 if(path==='/deep-brain')return byId.get('brain');
 if(path==='/'||path==='/index.html')return byId.get(oldWorkbenchKeys.some(k=>url.searchParams.has(k))?'workbench':'brain');
 return byPath.get(path);
}
// Internal query-based state remains compatible with saved links and research handoffs.
export function routeSearch(loc=globalThis.location){
 if(!loc)return '';
 if(new URLSearchParams(loc.search).has('page'))return loc.search;
 const route=resolveSiteRoute(new URL(loc.href||loc.pathname+loc.search,SITE_ORIGIN));
 if(!route)return loc.search;
 const query=new URLSearchParams({page:route.id});
 for(const [key,value] of new URLSearchParams(loc.search))query.append(key,value);
 return '?'+query;
}
export function routeHref(input,base=globalThis.location?.href||SITE_ORIGIN){
 const url=new URL(input,base);
 const route=resolveSiteRoute(url);
 if(!route||url.origin!==new URL(base).origin)return String(input);
 if(url.searchParams.get('page')==='wealth'){url.searchParams.delete('strategy');url.searchParams.delete('asset');}
 url.pathname=route.path;url.searchParams.delete('page');
 return url.pathname+url.search+url.hash;
}
export function indexableView(route,params){
 return route.indexable&&[...params.keys()].every(k=>k==='lang'||/^utm_[a-z0-9_]+$/i.test(k));
}
export function languagePath(route,language){
 const lang=seoLanguage(language);
 return route.path+(lang==='en'?'':'?lang='+lang);
}
export function alternatePaths(route){
 return [...Object.entries(seoLanguages).map(([key,[lang]])=>[lang,languagePath(route,key)]),['x-default',route.path]];
}
export function pageMeta(route,language,params){
 const lang=seoLanguage(language),zh=lang==='zh',translation=previews[lang]?.[route.id];
 const name=translation?.[0]||(zh?route.zh:route.en);
 const description=translation?.[1]||(zh?(route.descZh||'在 Astarter 工作区打开'+name+'。'):(route.descEn||'Open '+name+' in your Astarter workspace.'));
 const [htmlLanguage,ogLocale]=seoLanguages[lang];
 return {name,title:name+(zh?' · Astarter':' | Astarter'),description,canonical:SITE_ORIGIN+languagePath(route,lang),language:htmlLanguage,ogLocale,robots:indexableView(route,params)?'index, follow':'noindex, follow'};
}
