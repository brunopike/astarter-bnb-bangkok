import {loadAssetVenueLiquidations} from './browser-asset-liquidations.mjs';
import {loadAssetExchangeFlows} from './browser-exchange-flows.mjs';
import {pair as L} from './locale.mjs';
import {canAutoRefresh} from './product-composition.mjs';
import {CROSS_MARKETS,GOLD_SPOT,validateGoldSpot,validateCrossSnapshot} from './cross-market-data.mjs';
import {HUB_RESOURCES,normalizeHubResource} from './market-hub-data.mjs';
import {currentPublicEnvelope,publicRetryDelay,validatePublicEnvelope} from './public-data-client.mjs';
import {publicCuratedSocialFeed,publicRecentSocialFilters} from './public-data-views.mjs';
import {DIRECT_SOCIAL_REFRESH_MS,DIRECT_SOCIAL_VALID_MS,RECENT_SOCIAL_SCOPE,socialFiltersFromLocation} from './public-social-scope.mjs';
import {CHAIN_METRICS,CHAIN_INSIGHT_MAX_AGE,DERIVATIVE_VIEWS,DERIVATIVE_SYMBOLS,validateChainInsight,validateDerivativeBody} from './public-market-extended.mjs';
import {PUBLIC_LIGHTNING_SOURCE,validateLightningStatistics} from './public-lightning.mjs';
import {publicAccumulationView} from './public-accumulation-view.mjs';
import {PUBLIC_ETH_DISCLOSED_SOURCE,validateEthDisclosedBalance,renderEthDisclosedBalance} from './public-eth-disclosed.mjs';
import {PUBLIC_ETH_EXITS_SOURCE,validateEthExits} from './public-eth-exits.mjs';
import {PUBLIC_ETH_ACTIVE_BALANCE_SOURCE,validateEthActiveBalance} from './public-eth-consensus.mjs';
import {EXCHANGE_RESERVES_POLICY,validateExchangeReserves} from './public-exchange-reserves.mjs';
import {EXCHANGE_FLOW_POLICY,validateExchangeFlows} from './public-exchange-flows.mjs';
import {PUBLIC_BTC_DISCLOSED_SOURCE,validateBtcDisclosedBalance} from './public-btc-disclosed.mjs';
import {validateBtcExchangeFlows} from './public-btc-exchange-flows.mjs';
import {LIQUIDATION_ASSETS,validMarginPadLiquidations} from './public-marginpad-liquidations.mjs';
import {createLiquidationTape} from './venue-liquidation-stream.mjs';
import {validatePublicMacro,validatePublicMacroSeries} from './public-macro.mjs';
import {validateEthEtfHoldings} from './public-eth-etf-holdings.mjs';
import {ETH_FLOW_FUNDS,validatePublicEtf} from './public-etf.mjs';
import {validatePublicTraderBody} from './public-traders.mjs';

const MINUTE=60_000,DAY=86_400_000;
const derivativeLabels={funding:['资金费率','Funding rates'],oi:['持仓量','Open interest'],liquidation:['清算','Liquidations'],'venue-liquidations':['跨所清算','Cross-venue liquidations'],ratio:['多空比','Long/short ratio']};
const macroLabels={cpi:['CPI 指数（季调）','CPI index (seasonally adjusted)'],unemployment:['失业率','Unemployment rate'],payrolls:['非农就业人数','Nonfarm payroll employment']};
const chainAliases={'eth-exchange':'exchange-balance','validator-queue':'eth-validator-exits',staked:'eth-active-balance',supply:'btc-supply',active:'active-addresses','active-address':'active-addresses','stable-supply':'stablecoins',gas:'eth-gas',whales:'eth-transfers'};
const disclosedMetric='btc-disclosed-balance';
const chainLabels={
 'exchange-asset-flows':['充值与提币 · 披露地址','Deposits & withdrawals · disclosed wallets'],
 'exchange-balance':['交易所链上余额','On-chain exchange balances'],
 'exchange-netflow':['逐交易所净流量','Net flows by exchange'],
 'exchange-flow-24h':['交易所滚动净流量','Rolling exchange net flows'],
 'btc-disclosed-flows':['Crypto.com · BTC 披露地址资金流','Crypto.com · Disclosed BTC address flows'],
 'eth-disclosed-balance':['ETH 披露地址余额','ETH disclosed address balances'],
 'eth-validator-exits':['以太坊验证者退出队列','Ethereum validator exit queue'],
 lightning:['闪电网络公开通道容量','Public Lightning channel capacity'],channels:['闪电网络公开通道数','Public Lightning channel count'],
 accumulation:['BTC 积累地址持有量','BTC accumulation address supply'],'eth-active-balance':['以太坊活跃有效余额','Ethereum active effective balance'],
 [disclosedMetric]:['BTC 披露地址余额','BTC disclosed address balances'],
 mvrv:['BTC 市值 / 已实现市值','BTC MVRV'],sopr:['BTC 已花费输出盈亏比 · 24h','BTC spent output profit ratio · 24h'],
 'realized-price':['BTC 已实现价格','BTC realized price'],
 'realized-cap':['BTC 已实现市值','BTC realized capitalization'],nupl:['BTC 未实现净盈亏比率','BTC net unrealized profit/loss'],
 'lth-supply':['长期供应量 · 币龄 ≥150 天','Long-term supply · age ≥150 days'],'sth-supply':['短期供应量 · 币龄 <150 天','Short-term supply · age <150 days'],
 'lth-cost':['长期已实现价格 · 币龄 ≥150 天','Long-term realized price · age ≥150 days'],'sth-cost':['短期已实现价格 · 币龄 <150 天','Short-term realized price · age <150 days'],
 'profit-supply':['盈利供应占比 · 含盈亏平衡','Supply in profit · includes break-even'],
 'realized-profit':['链上已实现盈利 · 24h','On-chain realized profit · 24h'],'realized-loss':['链上已实现亏损额 · 24h','On-chain realized loss magnitude · 24h'],
 cdd:['币天销毁 · 24h','Coin days destroyed · 24h'],'spent-volume':['已花费 BTC · 含找零 · 24h','BTC spent · includes change · 24h'],
 'new-address':['首次出现的地址 · 24h','Newly seen addresses · 24h'],nonzero:['非零余额地址数','Addresses with a positive balance'],
 'whale-balance':['余额 ≥1,000 BTC 的地址持币量','Balances of addresses holding ≥1,000 BTC'],shrimp:['余额 <1 BTC 的地址持币量','Balances of addresses holding <1 BTC'],
 'block-fees':['平均每笔手续费 · 非币基交易 · 24h','Average fee per non-coinbase transaction · 24h'],
 tvl:['DeFi 锁仓量','DeFi TVL'],stablecoins:['稳定币流通量','Stablecoin supply'],chains:['各链 DeFi 锁仓','DeFi TVL by chain'],
 'stablecoin-netflow':['以太坊稳定币交易所净流入','Ethereum stablecoin exchange net flow'],
 hashrate:['BTC 算力','BTC hash rate'],'active-addresses':['BTC 活跃地址','BTC active addresses'],
 'btc-supply':['BTC 供应量','BTC supply'],'eth-gas':['ETH Gas 价格','ETH gas prices'],'eth-transfers':['大额 ETH 原生转账','Large native ETH transfers'],
 transactions:['BTC 确认交易笔数','BTC confirmed transactions'],fees:['BTC 区块手续费','BTC block transaction fees'],
 'miner-revenue':['BTC 矿工奖励','BTC miner rewards'],'block-size':['BTC 平均区块大小','BTC average block size'],
 difficulty:['BTC 挖矿难度','BTC mining difficulty'],mempool:['BTC 待确认交易','BTC pending transactions'],'mempool-size':['BTC 待确认交易体积','BTC pending transaction size']
};
const shortAddress=value=>value.slice(0,8)+'…'+value.slice(-6);
const validAddress=/^0x[0-9a-f]{40}$/i;
const etfEthFunds=new Set([...ETH_FLOW_FUNDS,'CETH']);
const titles={cross:['传统资产行情','Traditional market data'],derivatives:['合约与清算','Derivatives'],tracking:['链上指标','On-chain metrics'],macro:['美国宏观日历','US macro calendar'],'macro-series':['美国宏观数据','US macro data'],etf:['ETF 资金','ETF flows'],social:['社媒动向','Social trends'],traders:['交易员排行','Trader leaderboard']};
const sourceLink=(label,url)=>`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a>`;
const eastern=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York',dateStyle:'short',timeStyle:'medium'});
const dateTime=(at,zone='UTC')=>Number.isFinite(at)?zone==='America/New_York'?eastern.format(at):new Date(at).toISOString().slice(0,19).replace('T',' '):'—';
const dateLabel=at=>Number.isFinite(at)?new Date(at).toISOString().slice(0,10):'—';
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(value,decimals=2)=>Number.isFinite(value)?value.toLocaleString('en-US',{maximumFractionDigits:decimals}):'—';
const etherBalance=value=>{
 const [whole,fraction]=value.split('.');
 return BigInt(whole).toLocaleString('en-US')+(fraction?'.'+fraction:'')+' ETH';
};
const usd=value=>Number.isFinite(value)?(value<0?'−':'')+'$'+num(Math.abs(value)):'—';

export function liveDataRoute(page,search){
 const p=new URLSearchParams(search);
 if(p.get('data')==='demo')return null;
 const asset=p.get('asset'),view=p.get('view');
 const make=(kind,resource,query={},interval=MINUTE,stale=5*MINUTE)=>({kind,resource,query,interval,stale});
 if(page==='markets'&&!p.get('coin')&&Object.hasOwn(CROSS_MARKETS,asset||''))return make('cross','cross-candles',{symbol:asset});
 if(page==='derivatives'){
  const displayView=Object.keys(derivativeLabels).find(key=>key===view||derivativeLabels[key].includes(view))||'funding';
  const symbol=asset?.toUpperCase()||'BTC',venue=p.get('exchange');
  if(displayView==='venue-liquidations'){
   if(!venue&&LIQUIDATION_ASSETS.includes(symbol))return make('derivatives','derivatives',{view:displayView,symbol},30_000,5*MINUTE);
   return make('derivatives',!venue&&DERIVATIVE_SYMBOLS.includes(symbol)?'asset-liquidations':null,{view:displayView,symbol},MINUTE,10*MINUTE);
  }
  const supported=DERIVATIVE_SYMBOLS.includes(symbol)&&(!venue||venue==='OKX'||['全部交易所','All exchanges'].includes(venue));
  return make('derivatives',supported?'derivatives':null,{view:displayView,symbol},displayView==='liquidation'?30_000:MINUTE);
 }
 if(page==='tracking'){
  const requested=p.get('metric')||'tvl',metric=Object.hasOwn(chainAliases,requested)?chainAliases[requested]:requested;
  if(['exchange-asset-flows','exchange-inflow','exchange-outflow'].includes(metric)){
   const symbol=asset?.toUpperCase()||'BTC';
   return {...make('tracking',['BTC','ETH'].includes(symbol)?'exchange-asset-flows':null,{symbol},5*MINUTE,2*60*MINUTE),displayMetric:'exchange-asset-flows'};
  }
  if(metric==='exchange-balance'||metric==='exchange-flow-24h')return {...make('tracking','exchange-reserves',{},EXCHANGE_RESERVES_POLICY.interval,EXCHANGE_RESERVES_POLICY.stale),displayMetric:metric};
  if(metric==='btc-disclosed-flows')return make('tracking','btc-disclosed-flows',{},30*MINUTE,36*60*MINUTE);
  if(metric==='exchange-netflow')return make('tracking',metric,{},EXCHANGE_FLOW_POLICY.interval,EXCHANGE_FLOW_POLICY.stale);
  if(metric==='lightning'||metric==='channels')return make('tracking','chain-insight',{metric},PUBLIC_LIGHTNING_SOURCE.interval,PUBLIC_LIGHTNING_SOURCE.stale);
  if(metric==='eth-disclosed-balance')return make('tracking',metric,{},PUBLIC_ETH_DISCLOSED_SOURCE.interval,PUBLIC_ETH_DISCLOSED_SOURCE.stale);
  if(metric==='eth-validator-exits')return make('tracking',metric,{},PUBLIC_ETH_EXITS_SOURCE.interval,PUBLIC_ETH_EXITS_SOURCE.stale);
  if(metric==='eth-active-balance')return make('tracking',metric,{},PUBLIC_ETH_ACTIVE_BALANCE_SOURCE.interval,PUBLIC_ETH_ACTIVE_BALANCE_SOURCE.stale);
  if(metric===disclosedMetric)return make('tracking',disclosedMetric,{},PUBLIC_BTC_DISCLOSED_SOURCE.interval,PUBLIC_BTC_DISCLOSED_SOURCE.stale);
  if(['tvl','stablecoins','chains'].includes(metric))return make('tracking',metric,{},HUB_RESOURCES[metric].interval,HUB_RESOURCES[metric].stale);
  return make('tracking',CHAIN_METRICS.includes(metric)?'chain-insight':null,{metric},5*MINUTE,CHAIN_INSIGHT_MAX_AGE[metric]);
 }
 if(page==='intelligence'&&view==='calendar')return make('macro','macro',{},60*MINUTE,DAY);
 if(page==='intelligence'&&view==='economic-data'){
  const chosen=p.get('series'),series=Object.hasOwn(macroLabels,chosen||'')?chosen:'cpi';
  return make('macro-series','macro-series',{series},240*MINUTE,DAY);
 }
 if(page==='etf'){
  const fund=p.get('fund')?.toUpperCase(),symbol=asset?.toLowerCase()|| (etfEthFunds.has(fund)?'eth':'btc');
  if(symbol==='eth'&&!p.has('fund')&&!p.has('range')&&(!view||view==='holdings'))return make('etf','eth-etf-holdings',{},60*MINUTE,DAY);
  const archive=symbol==='eth'&&(view==='archive'||!view&&p.has('range'));
  const query={asset:symbol};
  if(archive)query.series='archive';
  else if(symbol==='eth'&&ETH_FLOW_FUNDS.includes(fund))query.fund=fund;
  return make('etf',['btc','eth'].includes(symbol)?'etf':null,query,60*MINUTE,DAY);
 }
 if(page==='social'){
  if(p.has('trader')){
   const address=p.get('trader').toLowerCase();
   return make('traders',validAddress.test(address)?'traders':null,{address},30_000,5*MINUTE);
  }
  if(['rank','排行榜','发现交易员','交易员排行'].includes(view))return make('traders','traders',{},15*MINUTE,60*MINUTE);
  const featured=p.get('social_feed')==='featured';
  return make('social','social',{selection_version:0,limit:50,feed:featured?'featured':'recent',...(featured?{}:socialFiltersFromLocation(p))},DIRECT_SOCIAL_REFRESH_MS,60*MINUTE);
 }
 return null;
}

export function validateLiveDataResponse(response,route,now=Date.now()){
 const {kind,resource,query}=route;
 if(kind==='social'){
  const body=validatePublicEnvelope(response,'social',query);
  const direct=body.coverage.scope===RECENT_SOCIAL_SCOPE;
  if(body.mode!=='live_readonly'||!['LUNARCRUSH_KOL_TOPICS','LUNARCRUSH_TOPICS',RECENT_SOCIAL_SCOPE].includes(body.coverage.scope)||body.quality==='unavailable'||!Number.isSafeInteger(body.as_of_ms)||body.as_of_ms<=0||body.as_of_ms>now+60_000)throw Error('INVALID_DATA');
  if(body.as_of_ms!==body.coverage.observed_at_ms||!body.sources.some(source=>source.status==='OK'&&(direct||source.provider_id==='lunarcrush-v4')))throw Error('INVALID_DATA');
  const fast=direct&&body.sources.some(source=>source.provider_id!=='lunarcrush-v4'&&source.status==='OK');
  return {body,receivedAt:body.as_of_ms,asOf:body.as_of_ms,validUntil:body.as_of_ms+(fast?DIRECT_SOCIAL_VALID_MS:route.stale)};
 }
 if(response?.schema!=='public-market-relay-v1'||response.resource!==resource||!Number.isSafeInteger(response.receivedAt)||response.receivedAt<=0||response.receivedAt>now+60_000)throw Error('INVALID_DATA');
 const {body,receivedAt}=response;
 let asOf=receivedAt,validUntil=receivedAt+route.stale,value=body;
 if(kind==='gold-spot'){
  if(!validateGoldSpot(body,receivedAt))throw Error('INVALID_DATA');
  asOf=body.asOf;validUntil=asOf+GOLD_SPOT.stale;
 }else if(kind==='cross'){
  validateCrossSnapshot(body,{symbol:query.symbol,...CROSS_MARKETS[query.symbol]},now);
  if(body.receivedAt!==receivedAt)throw Error('INVALID_DATA');
  asOf=body.quoteAsOf*1000;
  validUntil=body.validUntil*1000;
 }else if(kind==='derivatives'&&query.view==='venue-liquidations'){
  if(!validMarginPadLiquidations(body,receivedAt))throw Error('INVALID_DATA');
  const sourceTimes=[body.byAsset?.asOf,body.byVenue?.asOf].filter(Number.isFinite);
  asOf=Math.min(...sourceTimes);validUntil=Math.min(validUntil,asOf+route.stale);
 }else if(kind==='derivatives'){
  if(!validateDerivativeBody(body,query.view,query.symbol,receivedAt))throw Error('INVALID_DATA');
  asOf=body.current?.at??(query.view==='liquidation'?body.rows[0]?.at:body.rows.at(-1)?.at)??null;
  const sourceMaxAge=query.view==='liquidation'?Infinity:query.view==='funding'?DAY:3*DAY;
  if(asOf!==null)validUntil=Math.min(validUntil,asOf+sourceMaxAge);
 }else if(kind==='tracking'){
  if(resource==='btc-disclosed-flows'){
   if(!validateBtcExchangeFlows(body,receivedAt))throw Error('INVALID_DATA');
   asOf=body.windowEnd;validUntil=Math.min(validUntil,asOf+route.stale);
  }else if(resource==='exchange-netflow'){
   if(!validateExchangeFlows(body,receivedAt))throw Error('INVALID_DATA');
   asOf=body.endAt;validUntil=Math.min(validUntil,body.endAt+EXCHANGE_FLOW_POLICY.stale);
  }else if(resource==='exchange-reserves'){
   if(!validateExchangeReserves(body,receivedAt))throw Error('INVALID_DATA');
   asOf=body.asOf;validUntil=body.asOf+EXCHANGE_RESERVES_POLICY.stale;
  }else if(resource==='eth-disclosed-balance'){
   if(!validateEthDisclosedBalance(body,receivedAt)||body.receivedAt>receivedAt)throw Error('INVALID_DATA');
   asOf=body.sourceAsOf;validUntil=body.validUntil;
  }else if(resource==='eth-validator-exits'){
   if(!validateEthExits(body,receivedAt)||body.receivedAt>receivedAt)throw Error('INVALID_DATA');
   asOf=body.sourceAsOf;validUntil=body.validUntil;
  }else if(resource==='eth-active-balance'){
   if(!validateEthActiveBalance(body,receivedAt)||body.receivedAt>receivedAt)throw Error('INVALID_DATA');
   asOf=body.sourceAsOf;validUntil=body.validUntil;
  }else if(resource===disclosedMetric){
   if(!validateBtcDisclosedBalance(body,now)||body.receivedAt!==receivedAt)throw Error('INVALID_DATA');
   asOf=null;validUntil=body.validUntil;
  }else if(resource==='chain-insight'&&['lightning','channels'].includes(query.metric)){
   if(!validateLightningStatistics(body,query.metric,receivedAt)||body.receivedAt>receivedAt)throw Error('INVALID_DATA');
   asOf=body.asOf;validUntil=body.validUntil;
  }else if(resource==='chain-insight'){
   if(!validateChainInsight(body,query.metric,receivedAt))throw Error('INVALID_DATA');
   asOf=body.asOf;
   if(asOf!==null&&query.metric!=='eth-transfers')validUntil=asOf+route.stale;
  }else{
   value=normalizeHubResource(resource,body,receivedAt);
   asOf=value.asOf??null;
   validUntil=(asOf??receivedAt)+route.stale;
  }
 }else if(kind==='macro'){
  validatePublicMacro(body,receivedAt);
  asOf=null;
 }else if(kind==='macro-series'){
  validatePublicMacroSeries(body,query.series,receivedAt);
  asOf=Date.parse(body.observations.at(-1).period+'-01');
 }else if(resource==='eth-etf-holdings'){
  if(!validateEthEtfHoldings(body,receivedAt))throw Error('INVALID_DATA');
  asOf=Date.parse(body.partial?.date??body.complete.date);
  validUntil=Math.min(validUntil,asOf+7*DAY);
 }else if(kind==='etf'){
  if(!validatePublicEtf(body,query.asset,receivedAt,query.series,query.fund))throw Error('INVALID_DATA');
  asOf=Date.parse(body.coverage.datasetThrough);
  validUntil=Math.min(validUntil,asOf+7*DAY);
 }else if(kind==='traders'){
  if(!validatePublicTraderBody(body,query.address,receivedAt))throw Error('INVALID_DATA');
  asOf=body.kind==='profile'?body.positionsAsOf:body.sourceAsOf;
  if(body.kind==='profile')validUntil=Math.min(validUntil,body.positionsAsOf+route.stale);
 }
 return {body:value,receivedAt,asOf,validUntil};
}

export function createLiveDataViews({root,rerender,link,section,table,stat,chartPanel,empty,fetchImpl=globalThis.fetch,now=Date.now}){
 let current=null,activeKey='',needsPaint=false,paintedStatus='',suspended=false;
 let displayedReceipt=null,badgeState='';
 const recentRoutes=new Map();
 const tab=(title,page,params,on)=>link(title,page,params,on?'selected':'');
 const nav=(label,links)=>`<nav class="dc-section-nav" aria-label="${escapeHtml(label)}">${links.join('')}</nav>`;
 const select=(label,param,values,selected,display=value=>value)=>`<label><span>${escapeHtml(label)}</span><select data-dc-route-select="${param}" aria-label="${escapeHtml(label)}">${values.map(value=>`<option value="${escapeHtml(value)}" ${selected===value?'selected':''}>${escapeHtml(display(value))}</option>`).join('')}</select></label>`;
 const cell=(value,cls='')=>`<td class="${cls}">${value}</td>`;
 const row=(...values)=>'<tr>'+values.map(value=>cell(value)).join('')+'</tr>';
 const strip=(...stats)=>`<div class="dc-quote-strip">${stats.join('')}</div>`;
 const notes=text=>`<p class="dc-live-note">${text}</p>`;
 const chart=(key,title,series,unit,kind='line')=>series.length?chartPanel(key,{title,values:series.map(point=>point.value),labels:series.map(point=>point.at),unit,kind,height:270}):empty(L('暂无可绘制的数据','No chart observations'));
 const queryValue=key=>new URLSearchParams(globalThis.location?.search).get(key);
 const visible=()=>!!globalThis.document&&!document.hidden&&!suspended&&globalThis.navigator?.onLine!==false;
 const offline=()=>globalThis.navigator?.onLine===false;
 function abort(){
  if(current?.tape){current.tape.dispose();current.tape=null;}
  for(const s of [current,current?.spot,current?.breakdown]){
   if(!s?.controller)continue;
   const controller=s.controller;
   s.controller=null;s.pending=false;controller.abort();
  }
 }
 function sync(page){
  const route=liveDataRoute(page,globalThis.location?.search||'');
  const key=route?JSON.stringify([route.kind,route.resource,route.query,route.displayMetric]):'';
  if(key!==activeKey){
   abort();
   const saved=recentRoutes.get(key);
   if(saved)recentRoutes.delete(key);
   if([current,current?.spot,current?.breakdown].some(state=>state?.receipt||state?.failures)){
    recentRoutes.set(activeKey,current);
    if(recentRoutes.size>12)recentRoutes.delete(recentRoutes.keys().next().value);
   }
   activeKey=key;
   current=saved;
   if(!current){
    current=route?{route,pending:false,nextAt:0,failures:0}:null;
    if(route?.kind==='cross'&&route.query.symbol==='XAU'){
     current.spot={route:{kind:'gold-spot',resource:'gold-spot',query:{},interval:GOLD_SPOT.interval,stale:GOLD_SPOT.stale},nextAt:0,failures:0};
    }
    if(route?.resource==='exchange-asset-flows')current.read=loadAssetExchangeFlows;
    if(route?.resource==='asset-liquidations')current.read=loadAssetVenueLiquidations;
    if(route?.query.view==='venue-liquidations'&&route.resource==='derivatives'){
     current.breakdown={route:{resource:'asset-liquidations',kind:'asset-liquidations',query:{symbol:route.query.symbol},interval:MINUTE,stale:10*MINUTE},
      read:loadAssetVenueLiquidations,nextAt:0,failures:0};
    }
   }
   needsPaint=false;paintedStatus='';displayedReceipt=null;badgeState='';
  }
  return current;
 }
 const expired=s=>!!s.receipt&&(now()>=s.receipt.validUntil||!!s.error||offline());
 function stateStamp(s){return JSON.stringify([s.pending,s.error,expired(s),offline(),s.receipt?.receivedAt,s.spot&&expired(s.spot),s.breakdown&&expired(s.breakdown)]);}
 function paint(force=false){
  if(!current||!needsPaint||!globalThis.document||document.hidden||suspended)return;
  if(!force&&!canAutoRefresh(root)){
   const source=current.spot||current.breakdown||current;
   const stamp=badgeStamp(source);
   if(source.route.resource&&stamp!==badgeState){
    const badge=root.querySelector?.('.dc-live > .pd-status .pd-quality');
    if(badge)badge.outerHTML=statusBadge({...source,receipt:displayedReceipt});
    badgeState=stamp;
   }
   return;
  }
  needsPaint=false;const y=root.scrollTop;rerender();root.scrollTop=y;
 }
 function load(s,force=false){
  if(s?.route.query.view==='venue-liquidations'&&s.route.resource){
   if(visible()){
    s.tape??=createLiquidationTape(s.route.query.symbol,()=>{needsPaint=true;},{now});
    s.tape.tick();
   }else if(s.tape){s.tape.dispose();s.tape=null;needsPaint=true;}
  }
  if(s?.spot)load(s.spot,force);
  if(s?.breakdown)load(s.breakdown,force);
  if(!visible()||!s?.route.resource||s.pending||(!force||s.error)&&now()<s.nextAt)return;
  const timeout=['exchange-asset-flows','asset-liquidations'].includes(s.route.resource)?65_000:s.route.query.metric==='eth-transfers'||s.route.kind==='macro'||['eth-validator-exits','eth-disclosed-balance','btc-disclosed-flows'].includes(s.route.resource)?14_000:11_000;
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(timeout)]);
  s.controller=controller;s.pending=true;
  void (async()=>{
   let retry=0;
   try{
    const route=s.route;
    let receipt;
    if(s.read){
     const body=await s.read(route.query.symbol,{signal,fetchImpl});
     const asOf=body.asOf??body.windowEnd;
     let quality='fresh';
     if(route.resource==='exchange-asset-flows'){
      if(!body.rows.some(r=>r.status==='available'))throw Error(body.rows.some(r=>r.reason==='rate-limit')?'RATE_LIMIT':'SOURCE_UNAVAILABLE');
      if(body.rows.some(r=>r.status!=='available'))quality='partial';
     }
     receipt={body,asOf,receivedAt:now(),validUntil:asOf+route.stale,quality};
    }else{
     const url='/api/market-hub?'+new URLSearchParams({resource:route.resource,...route.query});
     const response=await fetchImpl(url,{method:'GET',headers:{Accept:'application/json'},credentials:'omit',cache:'no-store',redirect:'error',signal});
     retry=publicRetryDelay(response.headers?.get('Retry-After'),now())||0;
     if(!response.ok)throw Error(response.status===429?'RATE_LIMIT':'SOURCE_UNAVAILABLE');
     const text=await response.text();
     if(text.length>1_000_000||signal.aborted)throw Error('INVALID_DATA');
     receipt=validateLiveDataResponse(JSON.parse(text),route,now());
    }
    if(s.controller!==controller)return;
    s.receipt=receipt;s.error=null;s.failures=0;s.nextAt=now()+route.interval;
   }catch(error){
    if(s.controller!==controller)return;
    s.error=['RATE_LIMIT','PROVIDER_RATE_LIMIT'].includes(error.message)?'rate-limit':'unavailable';
    retry=Math.max(retry,Number(error.retryAfterMs)||0);
    s.failures++;s.nextAt=now()+Math.max(retry,Math.min(300_000,15_000*2**Math.min(s.failures-1,4)));
   }finally{
    if(s.controller===controller){
     s.pending=false;s.controller=null;needsPaint=true;paint();
    }
   }
  })();
 }
 const statusTextFor=s=>!s.route.resource?L('当前查询暂无数据源','No source for this query'):offline()?L('网络已断开','Network offline'):s.pending?L('正在读取','Loading'):s.error==='rate-limit'?L('来源限流','Source is rate limited'):s.error?L('来源暂不可用','Source unavailable'):
  s.route.resource==='etf'&&s.receipt?.body.coverage.latestStatus==='historical'?L('逐基金历史数据','Historical fund data'):expired(s)||s.route.kind==='social'&&s.receipt?.body.quality==='stale'?L('数据已过期','Stale data'):(s.receipt?.quality==='partial'||s.route.kind==='social'&&s.receipt?.body.quality==='partial')?L('部分可用','Partial data'):s.receipt?L('已更新','Updated'):L('等待读取','Waiting for data');
 function badgeStamp(s){
  return [offline(),s.pending,s.error,displayedReceipt&&now()>=displayedReceipt.validUntil].join('|');
 }
 function statusBadge(s){
  const quality=!s.receipt?'unavailable':expired(s)||s.route.kind==='social'&&s.receipt.body.quality==='stale'?'stale':(s.receipt.quality==='partial'||s.route.kind==='social'&&s.receipt.body.quality==='partial')?'partial':'fresh';
  return `<span class="pd-quality" data-quality="${quality}"><i></i>${statusTextFor(s)}</span>`;
 }
 function status(s){
  if(!s.route.resource)return '';
  // A user reading an open gallery keeps the receipt and timestamp currently on screen.
  displayedReceipt=s.receipt||null;badgeState=badgeStamp(s);
  const statusText=statusBadge(s);
  if(!s.receipt)return `<div class="pd-status" role="status">${statusText}</div>`;
  return `<div class="pd-status" role="status">${statusText}<time>${L('读取时间','Retrieved')} ${dateTime(s.receipt.receivedAt)} UTC</time></div>`;
 }
 function pageParams(page,s,preset=false){
  const params=new URLSearchParams(globalThis.location?.search);
  if(page==='social'){
   if(s.route.kind==='traders'&&!params.has('trader'))params.set('view',preset?'排行榜':'rank');
   else if(s.route.kind==='social'||params.get('view')==='mastodon')params.delete('view');
  }
  return params;
 }
 function header(page,s){
  const demoParams=Object.fromEntries(pageParams(page,s,true));
  const demo=page==='intelligence'?'':link(L('预设','Preset'),page,{...demoParams,data:'demo'},'dc-button');
  const refresh=s.route.resource?`<button type="button" class="dc-button" data-dc-live-refresh ${s.pending?'disabled':''}>${L('刷新','Refresh')}</button>`:'';
  const title=page==='social'?L('社媒动态','Social activity'):L(...titles[s.route.kind]);
  return `<header class="p-head dc-head"><div><h1>${title}</h1></div><div class="dc-head-actions">${refresh}${demo}</div></header>`;
 }
 const pending=s=>s.pending?L('正在读取真实数据','Loading source data'):s.error?L('数据暂不可用，可稍后刷新','Data unavailable. Try again shortly.'):L('等待读取','Waiting for data');

 function cross(s){
  const {symbol}=s.route.query,d=s.receipt?.body;
  const tabs=nav(L('传统资产','Traditional assets'),Object.keys(CROSS_MARKETS).map(code=>tab(code,'markets',{asset:code},code===symbol)));
  const spot=s.spot,quote=spot?.receipt?.body;
  const currentQuote=spot?section(L('黄金现货 · XAU/USD','Spot gold · XAU/USD'),quote?
   strip(stat(L('美元 / 金衡盎司','USD / troy oz'),num(quote.price,3),dateTime(quote.asOf)+' UTC')):empty(pending(spot)),sourceLink(GOLD_SPOT.source,GOLD_SPOT.sourceUrl)):'';
  if(!d)return tabs+currentQuote+section(symbol,empty(pending(s)));
  // History is expressed in the provider's trading sessions and carries no volume.
  const closed=d.bars.filter(bar=>bar.closedAt<=d.receivedAt/1000);
  const last=closed.at(-1),previous=closed.at(-2),delta=previous?last.close-previous.close:null;
  const unit=d.unit==='index'?L('点','points'):d.unit,change=previous?symbol==='US10Y'?num(delta*100,2)+' bp':num(delta/previous.close*100,2)+'%':'—';
  const quotes=strip(stat(L('收盘价','Last close'),num(last.close,3)+' '+unit,d.sessionDate),stat(L('较前一交易日','Previous session change'),change),stat(L('日内区间','Session low–high'),num(last.low,3)+' – '+num(last.high,3)),stat(L('成交量','Volume'),'—'));
  const candles=closed.slice(-160).map(b=>({...b,time:b.time*1000}));
  const body=chartPanel('tradfi-'+symbol,{title:symbol+' · '+L('已收盘日线','Closed daily candles'),bars:candles,period:'1D',unit,height:340});
  return tabs+currentQuote+section(symbol+' · '+d.source,quotes+notes(L('已收盘日线','Closed daily candles')+' · '+d.sessionDate+' · '+d.timezone+(spot&&expired(s)?' · '+L('日线已过期','Daily data stale'):''))+body);
 }
 function derivatives(s){
  const {view,symbol}=s.route.query,d=s.receipt?.body,title=L(...derivativeLabels[view]);
  const tabAsset=DERIVATIVE_SYMBOLS.includes(symbol)?symbol:'BTC';
  const multi='venue-liquidations',assets=DERIVATIVE_SYMBOLS;
  const tabs=nav(L('合约指标','Derivatives metrics'),[...DERIVATIVE_VIEWS.map(key=>tab(L(...derivativeLabels[key]),'derivatives',{view:key,asset:tabAsset,exchange:'OKX'},key===view)),
   tab(L(...derivativeLabels[multi]),'derivatives',{view:multi,asset:tabAsset},view===multi)]);
  if(view===multi){
   const selector=`<div class="dc-toolbar">${select(L('资产','Asset'),'asset',assets,symbol)}</div>`;
   if(!s.route.resource)return tabs+section(title,selector+empty(L('请选择支持的币种','Choose a supported asset')));
   const venueNames={binance:'Binance','binance-coin':'Binance COIN-M',bybit:'Bybit',okx:'OKX',htx:'HTX',gate:'Gate',hyperliquid:'Hyperliquid',bitfinex:'Bitfinex',bitget:'Bitget',kraken:'Kraken',lighter:'Lighter',aster:'Aster',dydx:'dYdX'};
   const venue=id=>Object.hasOwn(venueNames,id)?venueNames[id]:escapeHtml(id),tape=s.tape;
   const states={connecting:L('连接中','Connecting'),live:L('实时监听','Listening'),disconnected:L('连接中断','Disconnected')};
   const live=tape?.slots.some(v=>v.status==='live');
   const sessionEvents=tape?.events.map(e=>row(dateTime(e.at),venue(e.venue),e.position==='long'?L('多头','Long'):L('空头','Short'),num(e.size,8),num(e.amount)))||[];
   const liveEmpty=!tape||offline()?L('当前未连接交易所','Exchanges offline'):live?L('监听中，尚未收到强平事件','Listening for the first liquidation'):
    tape.slots.some(v=>v.status==='connecting')?L('正在订阅交易所','Connecting to exchanges'):L('连接中断，正在等待重连','Disconnected. Waiting to reconnect');
   const stream=section(symbol+' · '+L('实时强平','Live liquidations'),
    notes((tape?.slots||[]).map(v=>venue(v.venue)+' · '+states[v.status]).join('　'))+
    (sessionEvents.length?table([L('事件时间 UTC','Event time UTC'),L('交易所','Venue'),L('被清算持仓','Liquidated position'),symbol,L('名义额 / USDT','Notional / USDT')],sessionEvents):empty(liveEmpty))+
    notes(L('仅显示订阅后最近 25 笔。Binance 每秒最多一笔，按成交均价计。Bybit 每 500 毫秒推送，按破产价估算。','Latest 25 since subscription. Binance reports at most one per second at average execution price. Bybit publishes every 500 ms at bankruptcy price.')));
   const detail=s.breakdown||s,b=detail.receipt?.body;
   const coverage={complete:L('完整推送','Full feed'),sampled:L('抽样','Sampled'),unknown:L('未注明','Unspecified')};
   const stats=b?strip(stat(L('多头清算 · USD','Longs · USD'),usd(b.total.long)),stat(L('空头清算 · USD','Shorts · USD'),usd(b.total.short))):'';
   const ranked=b?[...b.rows].sort((a,c)=>(c.long+c.short)-(a.long+a.short)):[];
   const observed=b?stats+(ranked.length?table([L('交易所','Exchange'),L('多头 · USD','Longs · USD'),L('空头 · USD','Shorts · USD'),L('合计 · USD','Total · USD')],
    ranked.map(v=>row(venue(v.id)+'<small>'+coverage[v.coverage]+'</small>',usd(v.long),usd(v.short),usd(v.long+v.short)))):empty(L('该窗口内未记录清算','No liquidations recorded in this window'))):
    empty(detail?.pending?L('正在读取逐所清算','Loading venue totals'):L('逐所明细暂不可用','Venue breakdown unavailable'));
   const breakdown=section(symbol+' · '+L('各交易所 24 小时清算','24h liquidations by exchange'),selector+
    (b?notes(dateTime(b.start)+' — '+dateTime(b.asOf)+' UTC · '+num(b.total.count,0)+' '+L('笔','events')+(expired(detail)?' · '+L('上次更新','Last available snapshot'):'')):'')+observed,
    b?'<span class="dc-breakdown-sources">'+sourceLink(b.source.name,b.source.url)+sourceLink(L('覆盖范围','Coverage'),b.source.coverageUrl)+'</span>':'', 'dc-asset-breakdown');
   if(s.route.resource==='asset-liquidations')return tabs+breakdown+stream;
   const summaryTitle=symbol+' · '+L('近 24 小时清算','24h liquidations');
   if(!d)return tabs+breakdown+stream+section(summaryTitle,empty(pending(s)));
   const asset=d.byAsset?.rows.find(v=>v.symbol===symbol);
   const source=sourceLink('MarginPad','https://marginpad.io/liquidations/by-exchange/');
   const summary=asset?notes(dateTime(d.byAsset.asOf)+' UTC · '+L('覆盖交易所合计','Across covered venues'))+
    strip(stat(L('总额 · USD','Total · USD'),usd(asset.total)),stat(L('多头 · USD','Long · USD'),usd(asset.long)),stat(L('空头 · USD','Short · USD'),usd(asset.short))):
    empty(L('当前标的暂无汇总','No aggregate for this asset'));
   const allVenues=d.byVenue?notes(dateTime(d.byVenue.asOf)+' UTC')+
    table([L('交易所','Venue'),L('多头 · USD','Long · USD'),L('空头 · USD','Short · USD'),L('总额 · USD','Total · USD')],
     d.byVenue.rows.map(v=>row(venue(v.id),usd(v.long),usd(v.short),usd(v.total)))):
    empty(L('逐交易所汇总暂不可用','Venue aggregates unavailable'));
   return tabs+breakdown+stream+section(summaryTitle,summary,source)+
    section(L('全标的 · 各交易所 24 小时清算','All assets · 24h liquidations by venue'),allVenues,source);
  }
  const market=L('OKX · USDT 永续','OKX · USDT perpetuals');
  if(!s.route.resource)return tabs+section(title,empty(L('当前交易所或标的暂无数据连接','This venue or asset is unavailable'))+link(L('查看 OKX '+tabAsset,'View OKX '+tabAsset),'derivatives',{view,asset:tabAsset,exchange:'OKX'},'dc-button'));
  const toolbar=`<div class="dc-toolbar">${select(L('资产','Asset'),'asset',DERIVATIVE_SYMBOLS,symbol)}</div>`;
  if(!d)return tabs+section(title,toolbar+empty(pending(s)));
  const source=sourceLink('OKX', 'https://www.okx.com/docs-v5/en/');
  if(view==='liquidation'){
   const h=[L('时间 UTC','Time UTC'),L('被清算持仓','Liquidated position'),L('数量 / 张','Size / contracts'),L('破产价格 / USDT','Bankruptcy price / USDT')];
   const rows=d.rows.map(point=>row(dateTime(point.at),point.position==='long'?L('多头','Long'):L('空头','Short'),num(point.size,8),num(point.bankruptcyPrice,8)));
   return tabs+section(d.instrument+' · '+title,toolbar+notes(L('OKX 最近最多 50 条已完成清算','Up to 50 recent completed liquidations from OKX'))+(rows.length?table(h,rows):empty(L('上游当前没有返回清算记录','The source returned no events'))),source);
  }
  const unit=view==='oi'?'USD':view==='funding'?'%':'×';
  const value=view==='oi'?usd:value=>num(value,view==='funding'?8:4)+' '+unit;
  const latest=d.current??d.rows.at(-1);
  const scope=view==='ratio'?L('OKX · 按币种汇总的期货与永续账户人数比 · 1D','OKX · futures and perpetual account-count ratio by asset · 1D'):market;
  const context=view==='oi'?d.current?L('当前名义持仓','Current open interest'):L('最新日采样','Latest daily observation'):view==='funding'?L('最近实际结算','Most recent settlement'):L('最新日采样','Latest daily observation');
  const stats=latest?strip(stat(context,value(latest.value),dateTime(latest.at)+' UTC')):'';
  const rows=d.rows.slice(-15).reverse().map(point=>row(dateTime(point.at),value(point.value)));
  return tabs+section((d.instrument||symbol)+' · '+title,toolbar+notes(scope)+stats+
   chart('derivatives-'+view,title,d.rows,unit)+(rows.length?table([L('时间 UTC','Time UTC'),title],rows):''),source);
 }
 function renderCoinFlows(d){
  const amount=(raw,signed=false)=>{
   if(typeof raw!=='string'||!/^[-]?\d+(?:\.\d+)?$/.test(raw))return '—';
   const [whole,frac]=String(raw).split('.');
   const grouped=whole.replace(/\B(?=(\d{3})+(?!\d))/g,',');
   return (signed&&!whole.startsWith('-')&&/[1-9]/.test(raw)?'+':'')+grouped+(frac?'.'+frac:'');
  };
  const rows=d.rows.map(v=>row(escapeHtml(v.exchange)+'<small>'+v.addressCount+' '+L('个地址','addresses')+'</small>',
   amount(v.inflow),amount(v.outflow),amount(v.net,true)));
  const methodology=d.asset==='BTC'?L('已确认区块中的地址样本。扣除样本内部划转、找零及矿工费，归属不清的混合输入另行排除。','Confirmed blocks for the sampled addresses. Internal transfers, change, fees and unattributable mixed inputs are excluded.'):
   L('已确认时段内成功的原生 ETH 转账。排除样本内部划转、Gas 及合约内部调用。','Successful top-level native ETH transfers. Transfers within each sample, gas and internal calls are excluded.');
  const mixed=d.rows.reduce((n,r)=>n+(r.excludedMixedTxCount??0),0);
  const range=d.asset==='BTC'?L('至少 6 次确认 · 区块','6+ confirmations · Blocks')+' '+num(d.firstBlock,0)+' – '+num(d.lastBlock,0)+' · ':'';
  const open=root.querySelector?.('details[data-flow-sources="'+d.asset+'"]')?.open?' open':'';
  const disclosure=d.rows.map(r=>'<div><strong>'+escapeHtml(r.exchange)+'</strong> '+sourceLink(r.disclosedOn,r.disclosureUrl)+
   r.addresses.map(a=>'<code>'+escapeHtml(a)+'</code>').join('')+'</div>').join('');
  return notes(range+dateTime(d.windowStart)+' — '+dateTime(d.windowEnd)+' UTC · '+L('仅统计披露地址的对外流动','Flows across the disclosed address boundary only'))+
   table([L('交易所 · 样本','Exchange · sample'),L('充值','Deposits')+' · '+d.asset,L('提币','Withdrawals')+' · '+d.asset,L('净流量','Net flow')+' · '+d.asset],rows)+
   (d.rows.some(r=>r.status!=='available')?notes(L('— 表示该样本未能完整读取。','— indicates the sample could not be read in full.')):'')+
   '<details class="dc-flow-disclosure" data-flow-sources="'+d.asset+'"'+open+'><summary>'+L('统计口径与披露地址','Method & disclosed addresses')+'</summary>'+notes(methodology+
    (mixed?' '+L('本窗口排除','Excluded in window')+' '+mixed+' '+L('笔混合输入交易。','mixed-input transactions.'):''))
     +disclosure+'</details>';
 }
 function tracking(s){
  const metric=s.route.displayMetric||s.route.query.metric||s.route.resource;
  const title=Object.hasOwn(chainLabels,metric)?L(...chainLabels[metric]):escapeHtml(metric);
  const metrics=['exchange-asset-flows','exchange-balance','exchange-flow-24h','exchange-netflow','btc-disclosed-flows',...CHAIN_METRICS,disclosedMetric,'eth-disclosed-balance','eth-active-balance','eth-validator-exits','accumulation','lightning','channels'];
  const tabs='<div class="dc-toolbar">'+select(L('指标','Metric'),'metric',metrics.includes(metric)?metrics:[metric,...metrics],metric,
   key=>Object.hasOwn(chainLabels,key)?L(...chainLabels[key]):L('当前指标','Current metric'))+'</div>';
  if(metric==='exchange-asset-flows'){
   const symbol=s.route.query.symbol,d=s.receipt?.body;
   const picks=nav(L('选择币种','Choose asset'),['BTC','ETH'].map(a=>tab(a,'tracking',{metric,asset:a},a===symbol)));
   const content=!s.route.resource?empty(L('请选择 BTC 或 ETH','Choose BTC or ETH')):!d?empty(pending(s)):renderCoinFlows(d);
   return tabs+section((s.route.resource?symbol+' · ':'')+L('充值、提币与净流量','Deposits, withdrawals & net flow'),picks+content,
    d?sourceLink(d.asset==='ETH'?'Powered by Routescan.io APIs':d.source,d.sourceUrl):'','dc-asset-breakdown');
  }
  if(metric==='accumulation')return tabs+section(title,publicAccumulationView(L));
  if(!s.route.resource)return tabs+section(L('指标暂无数据源','Metric source unavailable'),empty(L('该指标需要经授权的历史数据或已核验的地址标签。','This metric requires authorized history or verified address labels.')));
  const d=s.receipt?.body;
  if(!d)return tabs+section(title,empty(pending(s)));
  if(metric==='exchange-flow-24h'){
   const signed=value=>Number.isFinite(value)?(value>0?'+':'')+usd(value):'—';
   const rows=d.rows.map(v=>row(escapeHtml(v.name),signed(v.net24hUsd),signed(v.net7dUsd)));
   return tabs+section(title,notes(dateTime(d.asOf)+' UTC · '+L('来源每小时更新','Source updates hourly'))+
    table([L('交易所','Exchange'),L('近 24 小时 · USD','Rolling 24h · USD'),L('近 7 日 · USD','Rolling 7d · USD')],rows)+
    notes(L('覆盖来源追踪的链上地址。原生 ETH 以余额变化估算。','Covers addresses tracked by the source. Native ETH flows are estimated from balance changes.'))+
    nav(L('相关数据','Related data'),[link(L('按币种查看充值与提币','Deposits & withdrawals by asset'),'tracking',{metric:'exchange-asset-flows',asset:'BTC'}),link(L('完整 UTC 日净流量','Completed UTC day'),'tracking',{metric:'exchange-netflow'}),link(L('交易所链上余额','On-chain exchange balances'),'tracking',{metric:'exchange-balance'})]),
    sourceLink(d.source.name,d.source.url)+' · '+sourceLink(d.source.license,d.source.licenseUrl));
  }
  if(metric==='exchange-balance'){
   const rows=d.rows.map(venue=>row(escapeHtml(venue.name),num(venue.btc,8),num(venue.eth,8)));
   const scope=notes(L('覆盖来源核验的链上地址。部分 BTC 余额包含关联地址，ETH 不含质押余额。数值沿用来源的舍入精度。',
    'Covers the address sets tracked by the source. Some BTC balances include linked addresses. ETH excludes staked balances. Amounts use the source’s rounding.'));
   return tabs+section(title,notes(dateTime(d.asOf)+' UTC')+table([L('交易所','Exchange'),'BTC','ETH'],rows)+scope+
    nav(L('相关链上数据','Related on-chain data'),[
     link(L('近 24 小时滚动净流量','Rolling 24h net flows'),'tracking',{metric:'exchange-flow-24h'}),
     link(L('完整 UTC 日净流量','Completed UTC day'),'tracking',{metric:'exchange-netflow'}),
     link(L('Crypto.com BTC 地址样本','Crypto.com BTC address sample'),'tracking',{metric:disclosedMetric}),
     link(L('Crypto.com ETH 地址样本','Crypto.com ETH address sample'),'tracking',{metric:'eth-disclosed-balance'})
    ]),sourceLink(d.source.name,d.source.url)+' · '+sourceLink(d.source.license,d.source.licenseUrl));
  }
  if(metric==='btc-disclosed-flows'){
   const btc=sats=>num(sats/100_000_000,8)+' BTC';
   const scope=L('按交易合并 Crypto.com 于 2022 年披露的 6 个地址。样本内部转账相互抵消，转出金额含由这些地址承担的矿工费。当前控制权未经复核。','Each transaction combines six addresses disclosed by Crypto.com in 2022. Movements within this set cancel out. Debits include fees paid by these addresses. Current control is unverified.');
   return tabs+section(title,notes(dateLabel(d.windowStart)+' UTC · '+num(d.txCount,0)+' '+L('笔确认交易','confirmed transactions'))+
    strip(stat(L('转入','Inflow'),btc(d.inflowSats)),stat(L('转出','Outflow'),btc(d.outflowSats)),stat(L('净额','Net flow'),(d.netSats>0?'+':'')+btc(d.netSats)))+
    notes(scope)+link(L('查看逐交易所净流量','View net flows by exchange'),'tracking',{metric:'exchange-netflow'},'dc-button'),
    sourceLink('Crypto.com',d.disclosureUrl)+' · '+sourceLink(d.source,d.sourceUrl),'dc-flow-totals');
  }
  if(metric==='exchange-netflow'){
   const signed=value=>value===null?'—':(value>0?'+':'')+usd(value);
   const rows=d.rows.map(item=>row(escapeHtml(item.name),signed(item.netUsd),signed(item.net7dUsd),
    item.assets.map(id=>id==='USD'?L('稳定币','Stablecoins'):escapeHtml(id)).join(' · ')));
   const window=dateLabel(d.startAt)+' UTC · '+L('完整自然日','Completed calendar day');
   const scope=notes(L('按披露钱包统计，剔除同一交易所内部划转。原生 ETH 净额按余额变化估算，稳定币限以太坊主网。各所覆盖资产见表。','Published wallets only. Internal transfers are excluded. Native ETH net flow uses balance changes. Stablecoins cover Ethereum mainnet. Asset coverage varies by venue.'));
   return tabs+section(title,notes(window)+table([L('交易所','Exchange'),L('当日净额 · USD','Daily net · USD'),L('近 7 日净额 · USD','7-day net · USD'),L('覆盖资产','Covered assets')],rows)+scope+
    nav(L('相关链上数据','Related on-chain data'),[link(L('按币种查看充值与提币','Deposits & withdrawals by asset'),'tracking',{metric:'exchange-asset-flows',asset:'BTC'}),link(L('近 24 小时滚动净流量','Rolling 24h net flows'),'tracking',{metric:'exchange-flow-24h'}),link(L('交易所链上余额','On-chain exchange balances'),'tracking',{metric:'exchange-balance'}),
     link(L('BTC 披露地址转入与转出','Disclosed BTC address inflows and outflows'),'tracking',{metric:'btc-disclosed-flows'}),link(L('以太坊稳定币净流入','Ethereum stablecoin net flows'),'tracking',{metric:'stablecoin-netflow'})]),
    sourceLink(d.source,d.sourceUrl)+' · '+sourceLink('CC BY 4.0','https://creativecommons.org/licenses/by/4.0/'));
  }
  if(metric==='eth-disclosed-balance')return tabs+renderEthDisclosedBalance(d,L,now());
  if(metric==='eth-validator-exits'){
   const balance=etherBalance(d.effectiveEth);
   return tabs+section(title,strip(stat(L('已排定退出','Scheduled to exit'),num(d.validatorCount,0),L('验证者','Validators')),
    stat(L('合计有效余额','Total effective balance'),balance,dateTime(d.sourceAsOf)+' UTC'))+
    notes(L('已终局 Slot ','Finalized slot ')+d.finalizedSlot+' · '+L('仍在活跃集中的未罚没验证者','Active, unslashed validators with a scheduled exit')),
    sourceLink('PublicNode',d.sourceUrl+'/eth/v1/beacon/headers/'+d.blockRoot)+' · '+sourceLink('Beacon API',d.methodUrl));
  }
  if(metric==='eth-active-balance'){
   const balance=etherBalance(d.activeEffectiveEth);
   return tabs+section(title,strip(stat(title,balance,dateTime(d.sourceAsOf)+' UTC'),stat('Epoch',String(d.epoch),L('已终局 Slot ','Finalized slot ')+d.finalizedSlot))+
    notes(L('该 Epoch 可参与投票的验证者有效余额合计。','Total effective balance eligible to vote in this epoch.')),
    sourceLink('PublicNode',d.sourceUrl+'/eth/v1/beacon/headers/'+d.blockRoot)+' · '+sourceLink('Lighthouse',d.methodUrl));
  }
  if(metric===disclosedMetric){
   const scope=L('Crypto.com 于 2022-11-11 披露的 6 个 BTC 地址。当前控制权未经复核，覆盖限于这组地址。','Six BTC addresses disclosed by Crypto.com on November 11, 2022. Coverage is limited to this set. Current control is unverified.');
   const utcWindow=new Date(d.requestStartedAt).toISOString()+' → '+new Date(d.receivedAt).toISOString();
   const stats=strip(stat(L('已确认余额合计','Total confirmed balance'),d.totalConfirmedBtc+' BTC',d.totalConfirmedSats+' sat'),stat(L('已读取地址','Addresses observed'),d.rows.length+' / '+d.coverage.addressCount));
   const rows=d.rows.map(item=>{
    const addressLink=`<a href="${escapeHtml(item.explorerUrl)}" title="${escapeHtml(item.address)}" aria-label="${escapeHtml(item.address)}" target="_blank" rel="noopener noreferrer">${shortAddress(item.address)} ↗</a>`;
    return row(addressLink,item.confirmedBtc,item.confirmedSats);
   });
   return tabs+section(L('Crypto.com 披露地址','Crypto.com disclosed addresses'),stats+notes(scope)+table([L('比特币地址','Bitcoin address'),'BTC','sat'],rows)+notes(L('读取窗口 · UTC','Observation window · UTC')+' '+utcWindow),sourceLink(L('Crypto.com 披露原文','Crypto.com disclosure'),d.disclosure.url)+' · '+sourceLink(d.source,d.sourceUrl));
  }
  if(metric==='eth-transfers'){
   const eth=(value)=>{const padded=value.padStart(19,'0'),fraction=padded.slice(-18).replace(/0+$/,'');return padded.slice(0,-18)+(fraction?'.'+fraction:'');};
   const rows=d.rows.map(item=>row(dateTime(item.at),`<span class="dc-live-amount">${eth(item.wei)}</span>`,`<span title="${item.from}">${shortAddress(item.from)}</span>`,`<span title="${item.to}">${shortAddress(item.to)}</span>`,sourceLink(L('交易','Transaction'),'https://eth.blockscout.com/tx/'+item.hash)));
   const scope=d.sample?L('安全区块样本','Safe-block sample')+' · '+d.sample.fromBlock+'–'+d.sample.throughBlock+' · '+dateTime(d.sample.throughAt)+' UTC':
    L('最近 24 小时','Past 24 hours');
   const limit=L('已确认的 Ethereum 主网原生 ETH 转账，单笔至少 100 ETH，最多 50 条。','Up to 50 confirmed native Ethereum mainnet transfers of at least 100 ETH.');
   return tabs+section(title,notes(scope+' · '+limit)+(rows.length?table([L('时间 UTC','Time UTC'),'ETH',L('转出','From'),L('转入','To'),L('链上记录','On-chain record')],rows):empty(L('上游未返回满足门槛的记录','No qualifying transfers returned'))),sourceLink(d.source,d.url));
  }
  if(metric==='eth-gas'){
   const gas=d.rows[0];
   return tabs+section(title,strip(stat(L('慢速','Slow'),num(gas.slow,4)+' gwei'),stat(L('标准','Standard'),num(gas.value,4)+' gwei'),stat(L('快速','Fast'),num(gas.fast,4)+' gwei',dateTime(gas.at)+' UTC')),sourceLink(d.source,d.url));
  }
  if(metric==='chains'){
   const rows=[...d.data].sort((a,b)=>b.tvl-a.tvl).slice(0,30).map(item=>row(escapeHtml(item.name),usd(item.tvl)));
   return tabs+section(title,table([L('公链','Chain'),'TVL / USD'],rows),sourceLink('DefiLlama','https://defillama.com/chains'));
  }
  const series=d.rows??d.data,unit=d.unit??'USD',last=series.at(-1);
  const unitLabel=({addresses:L('地址','addresses'),transactions:L('笔','transactions'),bytes:L('字节','bytes'),difficulty:''})[unit]??unit;
  const value=unit==='USD'?usd(last.value):[num(last.value,unit==='BTC'?8:3),unitLabel].filter(Boolean).join(' ');
  const stablecoinFlows=metric==='stablecoin-netflow';
  const provenance=d.source==='Bitview'?sourceLink('Bitview (bitview.space)','https://bitview.space/')+' · '+sourceLink('CC BY 4.0','https://creativecommons.org/licenses/by/4.0/')+' · '+sourceLink(L('原始序列','Source series'),d.url):
   stablecoinFlows?sourceLink('CryptoKeyhole',d.url)+' · '+sourceLink('CC BY 4.0','https://creativecommons.org/licenses/by/4.0/'):
   d.rows?sourceLink(d.source,d.url):sourceLink('DefiLlama',metric==='tvl'?'https://defillama.com/':'https://defillama.com/stablecoins');
  const scope=d.coverage?.scope==='PUBLIC_LIGHTNING_GOSSIP_SNAPSHOT'?notes(L('仅统计 '+d.source+' 观测且可确认资金交易的公开通道。','Public channels observed by '+d.source+' with a resolved funding transaction.')):
   stablecoinFlows?notes(L('仅统计来源跟踪的以太坊主网稳定币及交易所公开地址。图表按已结束的 UTC 日显示流入减流出。',
    'Covers tracked Ethereum mainnet stablecoins and published exchange addresses. Each completed UTC day shows inflows minus outflows.')):
   d.blocks?notes(L('最近 144 个 BTC 区块','Last 144 BTC blocks')+' · '+d.blocks.from+'–'+d.blocks.to+
   (metric==='miner-revenue'?' · '+L('含区块补贴及交易手续费','Includes subsidy and transaction fees'):'')):
   d.source==='Bitview'?notes(L('按 UTC 日转换，保留已结束日期的观测值。','Converted to UTC dates. Includes observations for completed dates.')):'';
  return tabs+section(title,scope+strip(stat(title,value,(series.length===1?dateTime(last.at):dateLabel(last.at))+' UTC'))+
   (series.length>1?chart('tracking-'+metric,title,series,unitLabel,stablecoinFlows?'bar':'line'):''),provenance);
 }
 function macroTabs(active){
  return nav(L('宏观数据视图','Macro views'),[
   tab(L('宏观日历','Macro calendar'),'intelligence',{view:'calendar'},active==='calendar'),
   tab(L('美国月度数据','US monthly data'),'intelligence',{view:'economic-data'},active==='series'),
   tab(L('新闻快讯','News feed'),'intelligence',{},false)
  ]);
 }
 function macro(s){
  const d=s.receipt?.body,when=queryValue('when')==='past'?'past':'upcoming';
  const filters=nav(L('日历时间','Calendar time'),['upcoming','past'].map(key=>tab(key==='past'?L('近期发布','Recent releases'):L('即将发布','Upcoming'),'intelligence',{view:'calendar',when:key},when===key)));
  const back=macroTabs('calendar');
  if(!d)return back+filters+section(L('发布安排','Release schedule'),empty(pending(s)));
  const today=dateTime(now(),d.timeZone).slice(0,10),sourceNames=Object.fromEntries(d.sources.map(source=>[source.id,source.name]));
  const isPast=event=>Boolean(event.release)||(event.scheduledAt?Date.parse(event.scheduledAt)<=now():event.date<today);
  const events=d.events.filter(event=>when==='past'?isPast(event):!isPast(event));
  if(when==='past')events.reverse();
  const metricTitle={CPI_U_MOM_SA:L('CPI 环比（季调）','CPI month over month (SA)'),UNEMPLOYMENT_RATE_SA:L('失业率（季调）','Unemployment rate (SA)'),FED_FUNDS_TARGET_RANGE:L('联邦基金目标区间','Fed funds target range')};
  const percent=value=>value===null?'—':Array.isArray(value)?value.map(n=>num(n,3)).join('–')+'%':num(value,2)+'%';
  const rows=events.map(event=>{
   const release=event.release,title=release?metricTitle[release.metric]+(release.period!==event.date?' · '+escapeHtml(release.period):''):escapeHtml(event.title);
   const cells=[event.date,event.time||L('仅日期','Date only'),title];
   if(when==='past')cells.push(percent(event.actual),percent(event.previous));
   const footnote=release?.vintageUrl?sourceLink('ALFRED',release.vintageUrl):'';
   const source=release?sourceLink(event.source==='fed'?L('联储声明','Fed statement'):L('BLS 新闻稿','BLS release'),release.url):sourceLink(sourceNames[event.source],event.sourceUrl);
   cells.push(footnote?source+' · '+footnote:source);
   return row(...cells);
  });
  const sourceStatus=d.sources.map(source=>{
   const label=({available:L('已读取','Available'),partial:L('部分可用','Partial'),unavailable:L('暂不可用','Unavailable')})[source.status];
   return sourceLink(source.name,source.url)+' · '+label;
  }).join('　');
  return back+filters+section(L('发布安排','Release schedule'),notes(when==='past'?L('美东时间。公布值与前值取自当期官方发布或 ALFRED 发布日快照。标为 ALFRED 的 CPI 环比由当期指数折算。利率前值为决议前区间。市场共识预期暂无来源。','US Eastern. Values use the dated official release or its ALFRED vintage. ALFRED CPI changes are calculated from the index. For rates, previous means the pre-decision range. Consensus forecasts are unavailable.'):L('时间按美国东部时区显示。市场共识预期暂无来源。','All times are US Eastern. Consensus forecasts are unavailable.'))+
   (rows.length?table([L('发布日期','Release date'),L('美东时间','US Eastern'),L('事件','Event'),...(when==='past'?[L('公布值','Actual'),L('前值','Previous')]:[]),L('来源','Source')],rows):empty(L('当前范围没有已读取的安排','No schedule entries in this range')))+notes(sourceStatus));
 }
 function macroSeries(s){
  const d=s.receipt?.body,series=s.route.query.series,title=L(...macroLabels[series]);
  const switches=nav(L('月度序列','Monthly series'),Object.keys(macroLabels).map(key=>tab(L(...macroLabels[key]),'intelligence',{view:'economic-data',series:key},key===series)));
  if(!d)return macroTabs('series')+switches+section(title,empty(pending(s)));
  const unit=({index:L('指数','index'),percent:'%',thousands:L('千人','thousands')})[d.unit];
  const value=point=>Number.isFinite(point.value)?num(point.value,d.unit==='index'?3:d.unit==='percent'?1:0)+' '+unit:'—';
  const last=d.observations.at(-1);
  const rows=[...d.observations].reverse().map(point=>row(point.period,value(point),point.preliminary?L('初值','Preliminary'):point.value===null?L('未报告','Unreported'):'—'));
  const scope=L('BLS 当前公布的月度序列，历史值可能修订。','Current BLS monthly series. Earlier observations may be revised.');
  return macroTabs('series')+switches+section(title,notes(scope)+strip(stat(L('最新观测','Latest observation'),value(last),last.period))+
   table([L('月份','Month'),L('观察值','Observation'),L('备注','Note')],rows),sourceLink(d.source,d.url));
 }
 function ethEtfHoldings(s){
  const title=L('ETH 持仓变化','ETH holdings changes'),d=s.receipt?.body;
  if(!d)return section(title,empty(pending(s)));
  const eth=value=>(value>0?'+':'')+num(value,4)+' ETH';
  const changeUsd=value=>(value>0?'+':'')+usd(value);
  const full=stat(L('最近完整交易日','Latest complete session'),eth(d.complete.netEth),d.complete.date+' · '+changeUsd(d.complete.netUsd));
  const open=d.partial?stat(L('最新部分披露','Latest partial session'),changeUsd(d.partial.netUsd),d.partial.date+' · '+
   d.partial.reported+'/'+d.partial.expected+' '+L('只基金已报告','funds reported')):'';
  const rows=d.fundObservations.map(item=>row(escapeHtml(item.ticker),escapeHtml(item.name),item.date,eth(item.changeEth)));
  const series=d.history.map(item=>({at:item.date,value:item.netUsd/1e6}));
  return section(title,strip(full,open)+notes(L('按发行人披露的 ETH 持仓变化计算，以当日 ETH 收盘价折算美元。','Calculated from changes in issuer-reported ETH holdings and valued at that day’s ETH closing price.'))+
   chart('eth-etf-holdings',L('已公布的持仓变化','Reported holdings changes'),series,L('百万 USD','USD millions'),'bar'),
   sourceLink(d.source.name,d.source.url)+' · '+sourceLink(d.source.license,d.source.licenseUrl))+
   section(L('主要基金持仓变化','Largest fund holdings changes'),
   rows.length?table([L('代码','Ticker'),L('基金','Fund'),L('报告日','Reported date'),L('变化量','Change')],rows):empty(L('暂无基金记录','No fund observations')),
   d.fundObservations.length+' / '+d.fundsCovered+' '+L('只基金','funds'));
 }
 function ethCashFlows(d){
  const title=L('逐基金现金净申赎','Cash net flows by fund');
  const history=[...d.days].reverse(),sessions=history.slice(0,2),last=sessions[0],requested=queryValue('fund')?.toUpperCase();
  const selected=d.funds.includes(requested)?requested:null;
  const amount=value=>{
   if(value===null)return '—';
   const color=value<0?'down':value>0?'up':'neutral';
   return `<span class="dc-${color}">${value>0?'+':''}${usd(value)}</span>`;
  };
  const all=selected?link(L('查看全部基金','All funds'),'etf',{asset:'eth',view:'flows'},'dc-button'):'';
  const summary=strip(...sessions.map(day=>{
   const reported=Object.values(day.funds).filter(Number.isFinite).length;
   const label=selected||reported+'/'+d.funds.length+' '+L('只基金已报告','funds reported');
   return stat(day.date,amount(selected?day.funds[selected]:day.totalUsd),label);
  }));
  const stale=d.coverage.latestStatus==='historical'?notes(L('来源最近公布日期 ','Latest date published by source ')+last.date):'';
  const dateRange=history.at(-1).date+' — '+last.date;
  const grid=selected?table([L('交易日','Trading session'),L('现金净申赎 / USD','Cash net flow / USD')],history.map(day=>row(day.date,amount(day.funds[selected])))):
   table([L('基金 / USD','Fund / USD'),...sessions.map(day=>day.date)],[...d.funds].sort((a,b)=>(Math.abs(last.funds[b]??0)-Math.abs(last.funds[a]??0))||a.localeCompare(b))
    .map(symbol=>row(link(symbol,'etf',{asset:'eth',view:'flows',fund:symbol}),...sessions.map(day=>amount(day.funds[symbol])))));
  const historySource=d.source.fundUrl?' · '+sourceLink(selected,d.source.fundUrl):'';
  return section(selected?selected+' · '+L('现金净申赎','Cash net flows'):title,stale+all+summary+(selected?notes(dateRange+' · '+history.length+' '+L('个交易日','sessions')):'')+grid+
   notes(L('按 10 万美元取整。0 为来源精度下的零值，— 为未报告。最新交易日可随 T+1 披露修订。','Rounded to $100,000. Zero is at source precision. A dash indicates no report. The latest session may be revised as T+1 reports arrive.')),
   sourceLink('CoinClass',d.source.url)+historySource,'dc-flow-totals');
 }
 function etf(s){
  const d=s.receipt?.body,holdings=s.route.resource==='eth-etf-holdings',asset=holdings?'eth':s.route.query.asset;
  const archive=s.route.query.series==='archive';
  const tabs=nav(L('ETF 资产','ETF asset'),['btc','eth'].map(key=>tab(key.toUpperCase(),'etf',{asset:key},key===asset)))+
   (asset==='eth'?nav(L('ETH ETF 数据','ETH ETF data'),[tab(L('现金净申赎','Cash net flows'),'etf',{asset,view:'flows'},!holdings&&!archive),
    tab(L('持仓变化','Holdings changes'),'etf',{asset,view:'holdings'},holdings),tab(L('历史申赎','Flow archive'),'etf',{asset,view:'archive'},archive)]):'');
  if(holdings)return tabs+ethEtfHoldings(s);
  if(!d)return tabs+section(L('每日净申赎','Daily net flows'),empty(s.route.resource?pending(s):L('请选择 BTC 或 ETH','Choose BTC or ETH')));
  if(asset==='eth'&&!archive)return tabs+ethCashFlows(d);
  const requestedFund=queryValue('fund')?.toUpperCase()||'',fund=d.funds.includes(requestedFund)?requestedFund:'';
  const range=['7','30','60'].includes(queryValue('range'))?Number(queryValue('range')):30;
  const rows=d.days.slice(-range),flow=day=>fund?day.funds[fund]:day.totalUsd,last=rows.at(-1);
  const cumulative=rows.every(day=>Number.isFinite(flow(day)))?rows.reduce((sum,day)=>sum+flow(day),0):null;
  const filter=nav(L('交易日范围','Trading sessions'),[7,30,60].map(days=>tab(String(days)+' '+L('交易日','sessions'),'etf',{asset,range:days,...(fund?{fund}:{})},range===days)));
  const fundChoices=[link(L('全部基金','All funds'),'etf',{asset,range},fund?'':'selected'),...d.funds.map(symbol=>link(symbol,'etf',{asset,range,fund:symbol},symbol===fund?'selected':''))];
  const caption=d.coverage.latestStatus==='historical'?L('历史数据。最新已报告日期 ','Historical dataset. Last reported date ')+d.coverage.datasetThrough:d.coverage.latestStatus==='pending'?L('最新日仍待数据源公布','Latest session awaiting the source'):L('最新数据日 ','Latest date ')+d.coverage.datasetThrough;
  const bread=sourceLink(d.source.name,d.source.url)+' · '+sourceLink(d.source.license,d.source.licenseUrl)+' · '+sourceLink(d.source.upstreamName,d.source.upstreamUrl);
  const chartRows=rows.filter(r=>Number.isFinite(flow(r))).map(r=>({at:r.date,value:flow(r)/1e6}));
  const grid=[...rows].reverse().map(day=>row(day.date,...(fund?[usd(flow(day))]:[usd(day.totalUsd),...d.funds.map(symbol=>usd(day.funds[symbol]))])));
  return tabs+filter+nav(L('基金','Fund'),fundChoices)+section(asset==='eth'?L('逐基金历史净申赎','Historical net flows by fund'):L('每日净申赎','Daily net flows'),notes(caption)+
   (requestedFund&&!fund?notes(L('这个基金不在来源的覆盖范围内','The selected fund is outside this dataset')):'')+
   strip(stat(L('最新一日','Latest session'),usd(flow(last)),last.date),stat(L('区间合计','Period total'),usd(cumulative),L('USD · 已报告金额','USD · reported amounts')))+
   chart('etf-live',fund||asset.toUpperCase(),chartRows,L('百万 USD','USD millions'),'bar')+
   table([L('交易日','Session'),...(fund?[fund]:[L('合计 / USD','Total / USD'),...d.funds])],grid)+
   notes(L('— 表示该基金该日暂无报告。图表仅绘制已公布的记录。','— denotes an unreported amount. The chart plots published observations only.')+' '+bread),
   asset==='eth'?link(fund&&ETH_FLOW_FUNDS.includes(fund)?fund+' · '+L('近期净申赎','Recent flows'):L('查看最新逐基金申赎','Latest fund flows'),'etf',
    {asset,view:'flows',...(ETH_FLOW_FUNDS.includes(fund)?{fund}:{})}):'');
 }
 function socialTabs(kind){
  return nav(L('社媒动态','Social activity'),[
   tab(L(...titles.social),'social',{},kind==='social'),
   tab(L(...titles.traders),'social',{view:'rank'},kind==='traders')
  ]);
 }
 function social(s){
  const d=currentPublicEnvelope(s.receipt?.body,now(),!!s.error||offline()),title=L(...titles.social);
  const featured=s.route.query.feed==='featured',feeds=nav(L('动态筛选','Feed selection'),[tab(L('最近动态','Recent posts'),'social',{},!featured),tab(L('精选作者','Featured creators'),'social',{social_feed:'featured'},featured)]);
  const filters=featured?'':publicRecentSocialFilters(s.route.query,'data-dc-route-select');
  const toolbar=`<div class="pd-social-toolbar">${socialTabs('social')}${feeds}${filters}</div>`;
  return toolbar+(d?publicCuratedSocialFeed(d,title):section(title,empty(pending(s)),featured?sourceLink('LunarCrush','https://lunarcrush.com'):''));
 }
 const performanceWindows={day:['日','Day'],week:['周','Week'],month:['月','Month'],allTime:['全部','All time']};
 function traders(s){
  const address=s.route.query.address,d=s.receipt?.body;
  const browse=socialTabs('traders');
  const source=sourceLink('Hyperliquid', 'https://app.hyperliquid.xyz/leaderboard');
  if(!s.route.resource)return browse+section(L('公开地址无效','Invalid public address'),empty(L('从交易员排行选择一个公开地址','Choose an address from the leaderboard')),source);
  if(!d)return browse+section(L('Hyperliquid 主网','Hyperliquid mainnet'),empty(pending(s)),source);
  if(d.kind==='leaderboard'){
   const rows=d.rows.map(item=>row(item.rank,link(`<span title="${item.address}">${shortAddress(item.address)}</span>`,'social',{trader:item.address}),usd(item.pnl),Number.isFinite(item.roiPct)?num(item.roiPct)+'%':'—',usd(item.volume),usd(item.accountValue)));
   return browse+section(L('Hyperliquid 月度盈亏排行','Hyperliquid monthly P&L leaderboard'),
    notes(d.rows.length+' / '+num(d.total,0)+L(' 个可排序公开地址 · 按来源的月度盈亏',' ranked public addresses · source-defined monthly P&L'))+
    (d.sourceAsOf?notes(L('排行榜源文件更新时间','Leaderboard source file updated')+' '+dateTime(d.sourceAsOf)+' UTC'):'')+
    (rows.length?table([L('排名','Rank'),L('公开地址','Public address'),L('盈亏 / USD','P&L / USD'),L('收益率','ROI'),L('成交量 / USD','Volume / USD'),L('账户净值 / USD','Equity / USD')],rows):empty(L('当前范围暂无记录','No records in this range'))),source);
  }
  const window=Object.hasOwn(performanceWindows,queryValue('window')||'')?queryValue('window'):'month';
  const currentWindow=d.performance.find(item=>item.window===window);
  const filters=nav(L('表现时段','Performance window'),Object.keys(performanceWindows).map(key=>tab(L(...performanceWindows[key]),'social',{trader:address,window:key},key===window)));
  const chartSeries=currentWindow.accountValueHistory.map(([at,value])=>({at,value}));
  const positions=d.positions.map(item=>row(escapeHtml(item.symbol),item.side==='long'?L('多','Long'):L('空','Short'),num(item.size,8),usd(item.entryPrice),usd(item.positionValue),usd(item.unrealizedPnl)));
  const fills=d.fills?.map(item=>row(dateTime(item.time),escapeHtml(item.symbol),item.side==='buy'?L('买入','Buy'):L('卖出','Sell'),num(item.price,8),num(item.size,8)));
  const fillsBody=fills?.length?table([L('时间 UTC','Time UTC'),L('标的','Instrument'),L('买卖','Side'),L('来源报价','Source price'),L('数量 / 基础资产','Size / base asset')],fills):
   empty(fills?L('来源返回无成交','The source reports no fills'):L('近期成交来源暂不可用','Recent fills unavailable'));
  return browse+section(L('公开地址表现','Public address performance'),notes(`<code class="dc-live-address">${address}</code>`)+filters+
   strip(stat(L('窗口盈亏','Window P&L'),usd(currentWindow.pnl)),stat(L('成交量','Volume'),usd(currentWindow.volume)),stat(L('永续账户价值','Perpetual account value'),usd(d.perpAccountValue)))+
   notes(L('账户净值及盈亏使用来源返回的样本窗口。','Equity and P&L use the source-reported observation window.')+(currentWindow.from?' '+dateTime(currentWindow.from)+' – '+dateTime(currentWindow.to)+' UTC':''))+
   chart('trader-equity',L('账户净值','Account equity'),chartSeries,'USD'),source)+
   section(L('默认永续市场当前持仓','Current positions on the default perp DEX'),notes(dateTime(d.positionsAsOf)+' UTC')+
    (positions.length?table([L('标的','Instrument'),L('方向','Side'),L('数量','Size'),L('开仓价','Entry'),L('持仓价值','Position value'),L('未实现盈亏','Unrealized P&L')],positions):empty(L('来源返回该市场无持仓','The source reports no open positions in this market'))))+
   section(L('近期公开成交','Recent public fills'),notes(L('最多 25 笔。报价币种随标的而异。','Up to 25 fills. The quote currency varies by instrument.'))+fillsBody);
 }
 const views={cross,derivatives,tracking,macro,'macro-series':macroSeries,etf,social,traders};
 globalThis.document?.addEventListener('visibilitychange',()=>{if(document.hidden)abort();});
 globalThis.window?.addEventListener('pagehide',()=>{suspended=true;abort();});
 globalThis.window?.addEventListener('pageshow',()=>{suspended=false;});
 return {
  render(page){
   const s=sync(page);if(!s)return null;
   load(s);paintedStatus=stateStamp(s);
   return `<div class="dc-root dc-live" data-data-center="${page}" data-public-data="live-${s.route.kind}">${header(page,s)}${status(s.spot||s.breakdown||s)}${views[s.route.kind](s)}</div>`;
  },
  bind(){
   root.querySelector?.('[data-dc-live-refresh]')?.addEventListener('click',()=>{load(current,true);needsPaint=true;paint(true);});
  },
  companionBrief(page){
   const s=sync(page);if(!s)return null;
   const primary=s.spot||s.breakdown||s;
   return {kind:'data',label:L('数据状态','Data status'),title:L(...titles[s.route.kind]),body:statusTextFor(primary),visual:'',
    href:'?'+pageParams(page,s),action:L('打开当前数据页','Open the data page'),
    modeLabel:L('只读数据','Read-only data'),source:s.spot?GOLD_SPOT.source:'',timestamp:primary.receipt?dateTime(s.spot?primary.receipt.asOf:primary.receipt.receivedAt)+' UTC':null};
  },
  tick(page){
   const s=sync(page);if(!s)return;
   load(s);if(stateStamp(s)!==paintedStatus)needsPaint=true;
   paint();
  }
 };
}
