import {pair as L} from './locale.mjs';
import {CONNECTION_OPTIONS,WALLET_NETWORKS,tradingConnections,walletTradingProfile} from './connection-options.mjs?v=20261120c';
import {ACCESS_COPY} from './trading-access.mjs?v=20261120c';
import {MARKET} from './data-center-fixtures.mjs';
import {tokenIcon,venueIcon} from './brand-icons.mjs';
import {protectionValid} from './strategy-protection.mjs';
import {gridChartLevels} from './trading-chart-data.mjs';
import {BOT_MARKETS,isBotSimulation,botRequiredCapital,MIN_ORDER_USDT} from './bot-runtime.mjs';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const connectionIdValid=id=>typeof id==='string'&&(!id||/^[\w][\w:.-]{0,79}$/.test(id));
const accountIdValid=id=>typeof id==='string'&&id.length<=64&&!/[\u0000-\u001f\u007f<>]/.test(id);
export const STRATEGY_MARKETS=[
 {id:'cex-spot',zh:'交易所 · 现货',en:'CEX · Spot'},
 {id:'cex-perp',zh:'交易所 · 合约',en:'CEX · Perpetual'},
 {id:'dex-spot',zh:'链上 · 现货',en:'DEX · Spot'},
 {id:'dex-perp',zh:'链上 · 合约',en:'DEX · Perpetual'},
 {id:'dex-lp',zh:'链上 · 流动性',en:'DEX · Liquidity'}
];
export function strategyMarkets(id){
 if(id==='S09-A')return ['dex-spot'];
 if(id==='S09-L')return ['dex-lp'];
 if(['RX02-P','RX02-A','RX03-S','RX04','RX05'].includes(id))return ['cex-spot','dex-spot'];
 return ['cex-spot'];
}
// A live research card with no venue still opens on the default Binance spot account. It does not adopt the research or send an order.
export function unpinnedCexSpotSetup(row){
 if(row?.freshness==='expired'||!row?.source?.instrument||!strategyMarkets(row.strategy).includes('cex-spot'))return false;
 const input=row.source.instrument;
 return !input.profileId&&!input.venueId&&!input.chainId&&typeof row.variant==='string';
}
export function strategyVenues(profile){
 return profile.startsWith('cex')?CONNECTION_OPTIONS.exchange.filter(v=>!v.wallet):profile==='dex-perp'?[{id:'hyperliquid',name:'Hyperliquid'}]:[{id:'uniswap',name:'Uniswap'},{id:'pancakeswap',name:'PancakeSwap'}];
}
export function routeAssets(route){
 if(route.chainId==='56')return ['BTC/USDT','ETH/USDT'];
 if(route.profileId.startsWith('dex'))return ['WETH/USDC','WBTC/USDC'];
 return MARKET.filter(a=>!['SPX','NDX','XAU','DXY','US10Y'].includes(a.symbol)).map(a=>a.symbol+'/USDT');
}
export function defaultStrategyRoute(id,draft,connections){
 const saved=draft?.executionRoute,profiles=strategyMarkets(id),profileId=profiles.includes(saved?.profileId)?saved.profileId:profiles[0];
 const venues=strategyVenues(profileId),preferred=profileId.startsWith('cex')?connections?.preferences?.exchange?.service:venues[0].id;
 const venueId=venues.find(v=>v.id===saved?.venueId)?.id||venues.find(v=>v.id===preferred)?.id||venues[0].id;
 const accountId=accountIdValid(saved?.accountId)?saved.accountId:'';
 const rememberedChain=['1','42161','8453'].includes(saved?.chainId)||saved?.chainId==='56'&&saved?.venueId==='pancakeswap'&&profileId==='dex-spot';
 const chainId=profileId.startsWith('cex')?'':id.startsWith('S09')?'1':rememberedChain?saved.chainId:'1';
 const market=typeof draft?.market==='string'&&/^[A-Z0-9]{2,18}\/(USDT|USDC)$/.test(draft.market)?draft.market:'';
 const connectionId=connectionIdValid(saved?.connectionId)?saved.connectionId:'';
 return attachConnectedBinanceSpot({profileId,venueId,accountId,connectionId,chainId,market},connections);
}
export function strategyRouteValid(id,route){
 const markets=route?.connectionId==='wallet-bsc'&&!String(id).startsWith('S09')?[...new Set([...strategyMarkets(id),'dex-spot'])]:strategyMarkets(id);
 return markets.includes(route?.profileId)&&strategyVenues(route.profileId).some(v=>v.id===route.venueId)&&accountIdValid(route.accountId)&&connectionIdValid(route.connectionId??'')&&/^[A-Z0-9]{2,18}\/(USDT|USDC)$/.test(route.market||'')&&(route.profileId.startsWith('cex')?!route.chainId:(id.startsWith('S09')?route.chainId==='1':route.chainId==='56'?route.venueId==='pancakeswap'&&route.profileId==='dex-spot':['1','42161','8453'].includes(route.chainId)));
}
export function strategyRouteReady(route,variant='baseline'){return Boolean(route?.connectionId&&connectionIdValid(route.connectionId)&&route.profileId==='cex-spot'&&route.venueId==='binance'&&route.accountId==='SIM-01'&&(variant==='S01-SIM'||variant==='S02-SIM'?Object.hasOwn(BOT_MARKETS,route.market):route.market==='BTC/USDT')&&!route.chainId);}
export function strategyConnection(route,connections){
 const record=tradingConnections(connections).find(r=>r.id===route?.connectionId);
 if(!record||record.accountId!==route.accountId)return null;
 return record.kind==='exchange'?route.profileId==='cex-'+record.market&&route.venueId===record.service&&!route.chainId?record:null:walletTradingProfile(record)===route.profileId&&record.chain===route.chainId&&(route.profileId!=='dex-perp'||route.venueId==='hyperliquid')?record:null;
}
export function bindStrategyConnection(route,connectionId,connections){
 const record=tradingConnections(connections).find(r=>r.id===connectionId);if(!record)return null;
 const next={...route,connectionId:record.id,accountId:record.accountId};return strategyConnection(next,connections)?next:null;
}
export function strategyAccessOptions(route,mode){
 return {connectionId:route?.connectionId||'',profileId:route?.profileId||'cex-spot',operation:mode==='signal'?'observe':route?.profileId?.startsWith('dex')?'auto':'entry'};
}
export function strategyRouteConnected(route,connections,access){
 return Boolean(strategyConnection(route,connections)&&access?.connectionId===route.connectionId&&access.ready);
}
export function routeSummary(route){
 if(!STRATEGY_MARKETS.some(p=>p.id===route.profileId))return L('交易设置需要重新确认','Review trading settings');
 const venue=strategyVenues(route.profileId).find(v=>v.id===route.venueId)?.name||route.venueId;
 const profile=STRATEGY_MARKETS.find(p=>p.id===route.profileId);
 return `${venue} · ${route.market} · ${profile?L(profile.zh,profile.en):''}`;
}
export const botGridPreviewKey=(route,variant='baseline')=>JSON.stringify([variant,route.profileId,route.venueId,route.accountId,route.connectionId||'',route.chainId,route.market]);
export function botRecommendationIssue(plan,reference,quote,now=Date.now()){
 const route=plan.executionRoute,seed=plan.simulationReference;
 if(!quote||!route||!plan.market||!['live','snapshot'].includes(quote.state)||!Number.isFinite(quote.asOf)||Math.abs(now-quote.asOf)>30_000||!Number.isFinite(quote.closedAt)||quote.closedAt>quote.asOf||quote.closedAt>now||![quote.price,quote.closedPrice].every(value=>Number.isFinite(value)&&value>0)||[quote,reference,seed].filter(Boolean).some(item=>item.market!==plan.market||item.venueId!==route.venueId||item.profileId!==route.profileId)||seed&&(!Number.isFinite(seed.asOf)||Math.abs(now-seed.asOf)>30_000))return 'MARKET_NOT_READY';
 if(reference&&plan.strategy==='S01'&&!(Number(plan.botParameters?.lower)<=quote.price&&Number(plan.botParameters?.upper)>=quote.price))return 'DEFAULT_RANGE_STALE';
 return null;
}
export function botBudgetAmount(plan){
 const cost=botRequiredCapital({...plan,amount:MIN_ORDER_USDT}),cap=Number(plan?.cap);
 if(!Number.isFinite(cost)||cost<=0||!Number.isFinite(cap)||cap<=0)return null;
 const amount=Math.min(1000,Math.floor(cap/cost*MIN_ORDER_USDT*100)/100);
 return amount>=MIN_ORDER_USDT?amount:null;
}
export function botGridPreview(previews,route,variant='baseline'){
 const saved=previews?.[botGridPreviewKey(route,variant)];
 if(!saved||!['lower','upper','count'].every(key=>(typeof saved[key]==='number'||typeof saved[key]==='string'&&saved[key].length<32)&&Number.isFinite(Number(saved[key])))||!['arithmetic','geometric'].includes(saved.mode))return null;
 const preview={lower:saved.lower,upper:saved.upper,count:saved.count,mode:saved.mode,applied:saved.applied===true};
 try{gridChartLevels({...preview,count:Number(preview.count),referencePrice:Number(preview.lower)});}catch{preview.applied=false;}
 return preview;
}
const spotPair=market=>/^[A-Z0-9]{2,18}\/USDT$/.test(market)?market:'BTC/USDT';
export function signedWalletRoute(record,market='BTC/USDT'){
 if(record?.id!=='wallet-bsc'||record.status!=='connected'||record.chain!=='56'||!/^0x[0-9a-f]{40}$/.test(record.accountId||''))return null;
 return {profileId:'dex-spot',venueId:'pancakeswap',chainId:'56',market:spotPair(market),connectionId:record.id,accountId:record.accountId};
}
export function signedExchangeRoute(record,market='BTC/USDT'){
 if(record?.kind!=='exchange'||record.service!=='binance'||record.market!=='spot'||record.status!=='connected'||!accountIdValid(record.accountId)||!connectionIdValid(record.id))return null;
 return {profileId:'cex-spot',venueId:'binance',chainId:'',market:spotPair(market),connectionId:record.id,accountId:record.accountId};
}
export function attachConnectedBinanceSpot(route,connections){
 if(!route||route.connectionId||route.profileId!=='cex-spot'||route.venueId!=='binance')return route;
 const records=tradingConnections(connections).filter(record=>signedExchangeRoute(record));
 if(!records.length)return route;
 const preferred=connections?.preferredTradingConnection;
 const live=records.find(record=>record.id===preferred)||records.find(record=>record.id==='binance-spot')||records.find(record=>record.access==='trade')||records[0];
 return {...route,connectionId:live.id,accountId:live.accountId,profileId:'cex-spot',venueId:'binance',chainId:''};
}
export function strategyRouteFields(id,route,connections,access,variant='baseline',accountOnly=false){
 const records=tradingConnections(connections),eligible=records.filter(record=>bindStrategyConnection(route,record.id,connections)),bound=strategyConnection(route,connections),profiles=strategyMarkets(id),ready=strategyRouteConnected(route,connections,access);
 const walletChoice=!String(id).startsWith('S09')?records.find(record=>record.id==='wallet-bsc'&&record.status==='connected'&&record.chain==='56'):null;
 const shownProfiles=walletChoice||route.connectionId==='wallet-bsc'?[...new Set([...profiles,'dex-spot'])]:profiles;
 const listed=walletChoice&&!eligible.some(record=>record.id===walletChoice.id)?[...eligible,walletChoice]:eligible;
 const option=(value,label,selected,disabled=false)=>`<option value="${esc(value)}" ${selected?'selected':''} ${disabled?'disabled':''}>${esc(label)}</option>`;
 const accountText=record=>record.id==='wallet-bsc'?record.label+' · '+L('链上钱包','On-chain wallet'):(record.label===record.accountId?record.accountId:record.label+' · '+record.accountId)+(record.access==='read'?' · '+L('只读','View only'):'');
 const unavailable=route.connectionId&&!listed.some(record=>record.id===route.connectionId),linked=bound?.status==='connected',settled=ready||linked,status=route.connectionId?(access?.code&&ACCESS_COPY[access.code]?L(...ACCESS_COPY[access.code].slice(0,2)):bound?L('接入尚未检查','Connection needs checking'):L('原接入不可用','Original connection unavailable')):L('请选择交易接入','Choose a trading connection');
 const venue=`<label class="sc-field">${L('交易平台','Trading venue')}<span class="bot-route-select">${venueIcon(route.venueId,{size:21})}<select name="routeVenue" data-strategy-route="venueId">${strategyVenues(route.profileId).map(v=>option(v.id,v.name,route.venueId===v.id)).join('')}</select></span></label>`;
 const account=`<label class="sc-field">${L('使用账户','Account')}<select name="routeAccount" data-strategy-route="connectionId" required>${option('',L('选择账户','Select account'),!route.connectionId)}${unavailable?option(route.connectionId,(bound?.id==='wallet-bsc'?bound.label:route.accountId||route.connectionId)+' · '+L('原接入不可用','Original connection unavailable'),true):''}${listed.map(record=>option(record.id,accountText(record),record.id===route.connectionId)).join('')}</select></label>`;
 const profile=`<label class="sc-field">${L('交易市场','Market')}<select name="routeProfile" data-strategy-route="profileId">${STRATEGY_MARKETS.map(p=>option(p.id,L(p.zh,p.en)+(shownProfiles.includes(p.id)?'':L(' · 尚未适配',' · Unavailable')),route.profileId===p.id,!shownProfiles.includes(p.id))).join('')}</select></label>`;
 const chainNetworks=WALLET_NETWORKS.filter(n=>String(id).startsWith('S09')?n.id==='1':n.id==='56');
 const chain=route.profileId.startsWith('dex')?`<label class="sc-field">${L('网络','Network')}<select name="routeChain" data-strategy-route="chainId">${chainNetworks.map(n=>option(n.id,n.name,n.id===route.chainId)).join('')}</select></label>`:'';
 const asset=`<label class="sc-field">${L('交易资产','Trading pair')}<span class="bot-route-select">${route.market?tokenIcon(route.market.split('/')[0],{size:21}):''}<select name="routeMarket" data-strategy-route="market" required>${option('',L('选择交易资产','Select trading pair'),!route.market)}${[...new Set([route.market,...routeAssets(route)])].filter(Boolean).map(m=>option(m,m+(['S01-SIM','S02-SIM'].includes(variant)&&!Object.hasOwn(BOT_MARKETS,m)?L(' · 仅研究',' · Research only'):''),route.market===m,['S01-SIM','S02-SIM'].includes(variant)&&!Object.hasOwn(BOT_MARKETS,m))).join('')}</select></span></label>`;
 const state=`<div class="bot-route-status ${settled?'is-connected':''}"><span><i></i>${status}</span><button type="button" class="sc-link" data-sc="route-connect">${L(settled?'管理连接':'检查或选择接入',settled?'Manage connection':'Check or choose connection')} →</button></div>`;
 if(accountOnly)return `<fieldset class="bot-route-fields bot-route-account" aria-label="${L('使用账户','Account')}">${account}${state}</fieldset>`;
 if(isBotSimulation({strategy:id,planVariant:variant})){
  const name=strategyVenues(route.profileId).find(v=>v.id===route.venueId)?.name||route.venueId,shownAccount=bound?.id==='wallet-bsc'?bound.label:route.accountId||L('选择账户','Select account');
  return `<fieldset class="bot-route-fields bot-route-compact" aria-label="${L('账户与交易对象','Account & instrument')}">${asset}<details class="bot-account-settings" data-bot-section="account" ${!route.connectionId||unavailable?'open':''}><summary><span><b>${esc(name)} · ${esc(shownAccount)}</b><small class="${settled?'is-connected':''}">${status}</small></span><span class="bot-detail-action"><span class="bot-account-change">${L('修改','Change')}</span><span class="bot-account-collapse">${L('收起','Collapse')}</span></span></summary><div class="bot-route-options">${venue}${account}${profile}${chain}</div>${state}</details></fieldset>`;
 }
 return `<fieldset class="bot-route-fields"><legend>${L('账户与交易对象','Account & instrument')}</legend>${venue}${account}${profile}${chain}${asset}${state}</fieldset>`;
}

// Editor buffers live in the existing workspace; they never reserve funds or create runs.
const editorKey=workspace=>'hive.bot.editors.v1:'+String(workspace.account?.scope||'local');
export function loadBotEditors(workspace){
 try{
  const saved=workspace.storage?.getItem(editorKey(workspace));
  if(saved){const buffers=JSON.parse(saved);if(buffers&&typeof buffers==='object'&&!Array.isArray(buffers))workspace.s.botEditors=buffers;}
 }catch{workspace.persistenceError='草稿暂不可读取，请检查本机存储。';}
 return workspace.s.botEditors||{};
}
export function botPlanFingerprint(draft){
 return JSON.stringify([draft.id,draft.version,draft.strategy,draft.planVariant||'baseline',draft.market,draft.executionRoute,draft.amount,draft.cap,draft.mode,draft.protection,draft.botParameters||null,...(draft.simulationReference?[draft.simulationReference]:[])]);
}
export function saveBotEditor(workspace,editor,key=editor?.id){
 if(!editor?.id)return;
 workspace.s.botEditors=loadBotEditors(workspace);
 workspace.s.botEditors[key]=JSON.parse(JSON.stringify(editor));
 const draftKey=editor.id+':draft:'+editor.draftId;
 if(editor.draftId&&key!==editor.id&&key!==draftKey)workspace.s.botEditors[draftKey]=JSON.parse(JSON.stringify(editor));
 workspace.touch();
 try{if(workspace.storage){const data=JSON.stringify(workspace.s.botEditors);workspace.storage.setItem(editorKey(workspace),data);if(workspace.storage.getItem(editorKey(workspace))!==data)throw Error();}}
 catch{workspace.persistenceError='草稿暂未保存，请检查本机存储。';}
 return !workspace.persistenceError;
}
export function clearBotEditor(workspace,id,restore=null,expected,alias=null){
 const previous=workspace.s.botEditors||{},key=editorKey(workspace);let buffers=previous;
 try{
  const saved=workspace.storage?.getItem(key);
  if(saved){buffers=JSON.parse(saved);if(!buffers||typeof buffers!=='object'||Array.isArray(buffers))throw Error();}
 }catch{workspace.persistenceError='草稿暂不可读取，请检查本机存储。';return false;}
 if(expected&&JSON.stringify(buffers[id])!==JSON.stringify(expected)){workspace.persistenceError='草稿已变化，请重新打开后再操作。';return false;}
 if(alias&&JSON.stringify(buffers[alias.key]||null)!==JSON.stringify(alias.expected)){workspace.persistenceError='原草稿已在其它编辑中更新，请重新核对。';return false;}
 const next={...buffers};if(restore)next[id]=JSON.parse(JSON.stringify(restore));else delete next[id];
 if(alias){if(alias.restore)next[alias.key]=JSON.parse(JSON.stringify(alias.restore));else delete next[alias.key];}
 workspace.s.botEditors=next;workspace.touch();
 try{
  if(workspace.persistenceError)throw Error();
  if(workspace.storage){const data=JSON.stringify(next);workspace.storage.setItem(key,data);if(workspace.storage.getItem(key)!==data)throw Error();}
 }catch{
  workspace.s.botEditors=previous;workspace.touch();
  try{workspace.storage?.setItem(key,JSON.stringify(buffers));}catch{}
  workspace.persistenceError='草稿暂未保存，请检查本机存储。';return false;
 }
 return true;
}
export function readBotEditor(workspace,id,draft,key=id){
 const buffers=loadBotEditors(workspace),saved=draft&&key!==id&&buffers[id+':draft:'+draft.id]||buffers[key];
 if(!saved||saved.id!==id||draft&&draft.strategy!==id||saved.draftId!==(draft?.id||null)||saved.baseVersion!==(draft?.version||null))return null;
 const numeric=value=>(typeof value==='number'||typeof value==='string'&&value.length<32)&&Number.isFinite(Number(value));
 if(![saved.amount,saved.cap,saved.researchBudget].every(numeric)||!['auto','signal','review','confirm'].includes(saved.mode)||!protectionValid(saved.protection)||!strategyRouteValid(id,{...saved.executionRoute,market:saved.executionRoute?.market||'BTC/USDT'}))return null;
 return JSON.parse(JSON.stringify(saved));
}
