import {normalizeAgentModels,safeModelIdentity} from './agent-models.mjs';
import {ORDER_MARKETS} from './order-markets.mjs';
// UI plans only; credentials never belong in a persisted connection preference.
export const CONNECTION_OPTIONS={
 exchange:[
  {id:'binance',name:'Binance',venue:'binance',detail:['现货 · 合约','Spot · Futures'],fields:['key','secret'],docs:'https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security'},
  {id:'okx',name:'OKX',venue:'okx',detail:['现货 · 合约','Spot · Futures'],fields:['key','secret','passphrase'],docs:'https://www.okx.com/docs-v5/en/'},
  {id:'bybit',name:'Bybit',venue:'bybit',detail:['现货 · 合约','Spot · Futures'],fields:['key','secret'],docs:'https://bybit-exchange.github.io/docs/v5/intro'},
  {id:'bitget',name:'Bitget',venue:'bitget',detail:['现货 · 合约','Spot · Futures'],fields:['key','secret','passphrase']},
  {id:'gate',name:'Gate',venue:'gate',detail:['现货 · 合约','Spot · Futures'],fields:['key','secret']},
  {id:'hyperliquid',name:'Hyperliquid',venue:'hyperliquid',detail:['通过钱包授权','Wallet authorization'],fields:[],wallet:true}
 ],
 data:[
  {id:'coingecko',name:'CoinGecko',detail:['资产资料与图标','Asset profiles & icons'],fields:['key']},
  {id:'coinglass',name:'CoinGlass',detail:['合约、清算与 ETF','Derivatives, liquidations & ETF'],fields:['key']},
  {id:'blockbeats',name:'BlockBeats',detail:['新闻与宏观事件','News & macro events'],fields:['key']},
  {id:'lunarcrush',name:'LunarCrush',detail:['社交热度与情绪','Social activity & sentiment'],fields:['key']},
  {id:'etherscan',name:'Etherscan',detail:['链上交易与合约资料','Chain transactions & contracts'],fields:['key']},
  {id:'bitquery',name:'Bitquery',detail:['DEX 交易与资金流','DEX trades & flows'],fields:['key']},
  {id:'alchemy',name:'Alchemy',detail:['RPC 与链上事件','RPC & chain events'],fields:['key']}
 ],
 ai:[{id:'official',name:'Astarter AI',detail:['官方模型','Official models'],fields:[]},
 {id:'openrouter',name:'OpenRouter',detail:['使用自己的 API','Use your own API'],fields:['key'],docs:'https://openrouter.ai/docs/quickstart'},
 {id:'gateway',name:'自有模型网关',nameEn:'Your model gateway',detail:['使用你自己的服务','Use your own service'],fields:['key']}],
 wallet:[{id:'metamask',name:'BSC 钱包',nameEn:'BSC wallet',detail:['BNB Chain','BNB Chain'],fields:[]},{id:'phantom',name:'Solana 钱包',nameEn:'Solana wallet',detail:['连接 Solana 钱包','Connect a Solana wallet'],fields:[]}],
 notifications:[{id:'inapp',name:'站内通知',nameEn:'In-app',detail:['在当前页面查看','Receive in this page'],fields:[]},{id:'telegram',name:'Telegram',detail:['推送到你的聊天','Send to your chat'],fields:[]},{id:'email',name:'邮件',nameEn:'Email',detail:['接收重要更新','Receive key updates'],fields:[]}]
};
export const NOTICE_EVENTS=['orders','risk','research'];
export const WALLET_NETWORKS=[{id:'56',name:'BNB Chain',family:'evm'},{id:'42161',name:'Arbitrum',family:'evm'},{id:'1',name:'Ethereum',family:'evm'},{id:'8453',name:'Base',family:'evm'},{id:'solana:mainnet',name:'Solana',family:'solana'}];
export const AI_MODES=[['balanced','均衡','Balanced'],['fast','极速','Fast'],['adaptive','自适应','Adaptive']];
export const defaultPreferences=()=>({exchange:{service:'binance',market:'spot',access:'read'},data:{source:'official',services:[]},ai:{source:'official',service:'official',model:'balanced',endpoint:'',modelId:'',customService:'openrouter',agents:normalizeAgentModels()},wallet:{service:'metamask',network:'evm',chain:'56',venue:'wallet',address:'',access:'read'},notifications:{service:'inapp',events:[...NOTICE_EVENTS],email:'',telegramChatId:''}});
const connectionText=(value,max)=>typeof value==='string'&&value.trim().length<=max&&!/[\u0000-\u001f\u007f<>]/.test(value)&&!/^(?:sk[-_]|rk[-_]|AIza|gh[pousr]_|Bearer\s)|^(?:0x)?[a-f\d]{64}$/i.test(value.trim())?value.trim():'';
export function normalizeTradingConnections(records){
 if(!Array.isArray(records))return [];
 const result=[],seen=new Set();
 for(const record of records.slice(0,20)){
  if(!record||!['exchange','wallet'].includes(record.kind)||!CONNECTION_OPTIONS[record.kind].some(o=>o.id===record.service&&!o.wallet))continue;
  const id=connectionText(record.id,80);if(!/^[\w][\w:.-]*$/.test(id)||seen.has(id))continue;
  const p=normalizeConnectionPreferences({[record.kind]:record})[record.kind],accountId=connectionText(record.accountId,64)||'UNCONNECTED';
  const status=['unchecked','connected','disconnected','denied','expired'].includes(record.status)?record.status:'';
  const checkedAt=Number.isSafeInteger(record.checkedAt)&&record.checkedAt>=0?record.checkedAt:null;
  const reason=['restricted-location','timeout','check-failed'].includes(record.reason)?record.reason:'';
  const spot=record.kind==='exchange'&&p.service==='binance'&&p.market==='spot'&&status==='connected';
  const available=spot&&typeof record.available==='number'&&Number.isFinite(record.available)&&record.available>=0&&record.available<=1e15?record.available:null;
  const locked=available!==null&&typeof record.locked==='number'&&Number.isFinite(record.locked)&&record.locked>=0&&record.locked<=1e15?record.locked:0;
  result.push({id,kind:record.kind,service:p.service,label:connectionText(record.label,40)||accountId,accountId,...(record.kind==='exchange'?{market:p.market,access:p.access}:{chain:p.chain,network:p.network,venue:p.venue,access:p.access}),...(status?{status}:{}),...(checkedAt===null?{}:{checkedAt}),...(reason?{reason}:{}),...(available===null?{}:{available,locked})});seen.add(id);
 }
 return result;
}
export function tradingConnections(connections){
 if(Array.isArray(connections?.tradingAccounts))return normalizeTradingConnections(connections.tradingAccounts);
 if(!connections?.exchange)return [];
 const p=normalizeConnectionPreferences(connections.preferences).exchange;
 return normalizeTradingConnections([{id:'legacy-exchange',kind:'exchange',...p,accountId:p.service==='binance'?'SIM-01':'UNCONNECTED',label:p.service==='binance'?'SIM-01':p.service}]);
}
const CHECKED_STATUS=['unchecked','connected','disconnected','denied','expired'];
export function applyCheckedTradingConnection(connections,body){
 const base=connections&&typeof connections==='object'&&!Array.isArray(connections)?{...connections}:{};
 const serverRows=(Array.isArray(body?.connections)?body.connections:[]).filter(record=>record&&record.venue==='binance'&&record.kind==='CEX'&&CHECKED_STATUS.includes(record.status)&&(record.connectionId==='binance-spot'&&record.market==='spot'||record.connectionId==='binance-perp'&&record.market==='perp'));
 const kept=tradingConnections(base).filter(record=>record.accountId!=='BINANCE-SPOT'&&record.accountId!=='BINANCE-PERP'&&!serverRows.some(row=>row.connectionId===record.id));
 if(!serverRows.length){
  if(kept.length===tradingConnections(base).length)return base;
  const preferred=base.preferredTradingConnection==='binance-spot'||base.preferredTradingConnection==='binance-perp'?'':base.preferredTradingConnection;
  return {...base,tradingAccounts:kept,preferredTradingConnection:kept.some(record=>record.id===preferred)?preferred:''};
 }
 const accounts=serverRows.map(row=>{
  const reason=['restricted-location','timeout','check-failed'].includes(row.reason)?row.reason:'';
  const label=connectionText(row.label,40)||'Binance';
  const available=row.market==='spot'&&row.status==='connected'&&typeof row.available==='number'&&Number.isFinite(row.available)&&row.available>=0&&row.available<=1e15?row.available:null;
  const locked=available!==null&&typeof row.locked==='number'&&Number.isFinite(row.locked)&&row.locked>=0&&row.locked<=1e15?row.locked:0;
  return {id:row.connectionId,kind:'exchange',service:'binance',market:row.market,access:row.permission==='trade'?'trade':'read',accountId:row.market==='spot'?'BINANCE-SPOT':'BINANCE-PERP',label,status:row.status,checkedAt:Number.isSafeInteger(row.checkedAt)&&row.checkedAt>=0?row.checkedAt:0,...(reason?{reason}:{}),...(available===null?{}:{available,locked})};
 });
 const preferred=accounts.some(record=>record.id==='binance-spot')?'binance-spot':accounts[0].id;
 const spotBook=publicSpotBook(body?.spotBook);
 return {...base,exchange:accounts.some(record=>record.status==='connected')?true:base.exchange,tradingAccounts:[...kept,...accounts],preferredTradingConnection:preferred,...(spotBook?{spotBook}:{})};
}
export function preferredTradingConnection(connections,profileId){
 const records=tradingConnections(connections),id=Array.isArray(connections?.tradingAccounts)?connections.preferredTradingConnection:'legacy-exchange',record=records.find(r=>r.id===id);
 if(!record)return null;
 return !profileId||(record.kind==='exchange'?'cex-'+record.market:walletTradingProfile(record))===profileId?record:null;
}
export function connectedSpotBalance(connections){
 const book=connections?.spotBook;
 const live=book?.symbol==='BTCUSDT'&&typeof book.usdt==='number'&&Number.isFinite(book.usdt)&&book.usdt>=0&&book.usdt<=1e15?book:null;
 if(!live)return null;
 const available=live.usdt;
 const locked=typeof live.usdtLocked==='number'&&Number.isFinite(live.usdtLocked)&&live.usdtLocked>=0?live.usdtLocked:0;
 const btc=typeof live.btc==='number'&&Number.isFinite(live.btc)&&live.btc>=0?live.btc:null;
 const price=typeof live.btcPrice==='number'&&Number.isFinite(live.btcPrice)&&live.btcPrice>0?live.btcPrice:0;
 const spotEquity=available+locked+(btc===null?0:btc*price);
 const equity=typeof live.equityUsd==='number'&&Number.isFinite(live.equityUsd)&&live.equityUsd>=0&&live.equityUsd<=1e15?Math.max(spotEquity,live.equityUsd):spotEquity;
 return {available,locked,equity,unit:'USDT',...(btc===null?{}:{btc})};
}
const boundedAmount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e15?value:null;
export function connectedAccountBalances(connections){
 const records=connections?.tradingAccounts;
 if(!Array.isArray(records))return [];
 const balances=[];
 const wallet=records.find(row=>row?.id==='wallet-bsc'&&row.status==='connected'&&/^0x[0-9a-f]{40}$/i.test(row.accountId));
 if(wallet){
  const accountId=wallet.accountId.toLowerCase();
  const book=connections.walletBook?.accountId?.toLowerCase()===accountId?connections.walletBook:null;
  const available=boundedAmount(book?.usdt);
  balances.push({kind:'wallet',accountId,equity:available,available,btc:boundedAmount(book?.btc),locked:null,basis:'cash'});
 }
 const exchange=records.find(row=>row?.id==='binance-spot'&&row.status==='connected');
 if(exchange){
  const spot=connectedSpotBalance(connections),available=spot?.available??boundedAmount(exchange.available);
  balances.push({kind:'binance',accountId:'BINANCE-SPOT',equity:spot?spot.equity:available,available,btc:spot?.btc??null,locked:spot?.locked??boundedAmount(exchange.locked),basis:spot?'equity':'cash'});
 }
 return balances;
}
export function spendableSpotUsdt(connections,route,riskCap){
 if(route?.accountId!=='BINANCE-SPOT'||route?.connectionId!=='binance-spot')return null;
 const book=connectedSpotBalance(connections);
 if(!book)return null;
 const cap=Number(riskCap);
 if(!Number.isFinite(cap)||cap<0)return null;
 return Math.max(0,Math.min(book.available,cap));
}
const BSC_TOKENS={USDT:'0x55d398326f99059ff775485246999027b3197955',BTC:'0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c'};
const tokenAmount=result=>{
 if(typeof result!=='string'||!/^0x[0-9a-fA-F]{1,64}$/.test(result))return null;
 const raw=BigInt(result);
 if(raw>10n**30n)return null;
 const value=Number(raw/10n**12n)/1e6;
 return Number.isFinite(value)&&value>=0&&value<=1e15?value:null;
};
export async function readBscSpotBalances(address,fetchImpl=globalThis.fetch){
 const account=typeof address==='string'?address.toLowerCase():'';
 if(!/^0x[0-9a-f]{40}$/.test(account)||typeof fetchImpl!=='function')return null;
 const data='0x70a08231'+account.slice(2).padStart(64,'0');
 const call=async token=>{
  const response=await fetchImpl('https://bsc-dataseed.binance.org/',{method:'POST',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:token,data},'latest']})});
  if(!response?.ok)return null;
  const body=await response.json();
  return tokenAmount(body?.result);
 };
 try{
  const [usdt,btc]=await Promise.all([call(BSC_TOKENS.USDT),call(BSC_TOKENS.BTC)]);
  if(usdt===null)return null;
  return {accountId:account,usdt,btc:btc??0};
 }catch{return null;}
}
export function spendableWalletUsdt(connections,route,riskCap){
 const book=connections?.walletBook;
 if(route?.connectionId!=='wallet-bsc'||route?.venueId!=='pancakeswap'||route?.profileId!=='dex-spot'||route?.chainId!=='56'||!/^0x[0-9a-f]{40}$/.test(route?.accountId||'')||book?.accountId!==route.accountId)return null;
 const cap=Number(riskCap);
 if(typeof book.usdt!=='number'||!Number.isFinite(book.usdt)||book.usdt<0||book.usdt>1e15||!Number.isFinite(cap)||cap<0)return null;
 return Math.max(0,Math.min(book.usdt,cap));
}
export function publicSpotBook(value){
 if(!value||value.symbol!=='BTCUSDT'||!Array.isArray(value.orders))return null;
 const amount=input=>{const number=typeof input==='number'?input:Number(input);return Number.isFinite(number)&&number>=0&&number<=1e15?number:null;};
 const usdt=amount(value.usdt),usdtLocked=amount(value.usdtLocked??0),btc=amount(value.btc);
 if(usdt===null||usdtLocked===null||btc===null)return null;
 const STATUSES=new Set(['NEW','PARTIALLY_FILLED','FILLED','CANCELED','PENDING_CANCEL','REJECTED','EXPIRED','EXPIRED_IN_MATCH']);
 const TYPES=new Set(['LIMIT','MARKET','LIMIT_MAKER','STOP_LOSS_LIMIT','TAKE_PROFIT_LIMIT']);
 const listed=(row,open)=>{
  if(!row||(row.side!=='BUY'&&row.side!=='SELL')||!STATUSES.has(String(row.status||'')))return null;
  if(open&&row.status!=='NEW'&&row.status!=='PARTIALLY_FILLED')return null;
  if(!open&&(row.status==='NEW'||row.status==='PARTIALLY_FILLED'))return null;
  if(amount(row.price)===null||amount(row.origQty)===null||amount(row.executedQty??0)===null)return null;
  const orderId=String(row.orderId||'');if(!/^\d{1,20}$/.test(orderId))return null;
  const time=Number(row.time),strategy=row.strategy==='S01'||row.strategy==='S02'?row.strategy:'';
  const quote=amount(row.cummulativeQuoteQty??row.cumulativeQuoteQty);
  return {orderId,side:row.side,type:TYPES.has(row.type)?row.type:'',price:String(row.price),origQty:String(row.origQty),executedQty:String(row.executedQty??'0'),status:String(row.status),...(quote>0?{cummulativeQuoteQty:String(row.cummulativeQuoteQty??row.cumulativeQuoteQty)}:{}),...(Number.isSafeInteger(time)&&time>0?{time}:{}),...(strategy?{strategy}:{})};
 };
 const orders=value.orders.slice(0,8).map(row=>listed(row,true)).filter(Boolean);
 const history=(Array.isArray(value.history)?value.history:[]).slice(0,20).map(row=>listed(row,false)).filter(Boolean);
 const btcPrice=value.btcPrice==null?null:amount(value.btcPrice);
 const bnbPrice=value.bnbPrice==null?null:amount(value.bnbPrice);
 const equityUsd=value.equityUsd==null?null:amount(value.equityUsd);
 const assets=new Set(['USDT','BTC','BNB']);
 const trades=(Array.isArray(value.trades)?value.trades:[]).slice(0,50).map(row=>{
  const price=amount(row?.price),qty=amount(row?.qty),quoteQty=amount(row?.quoteQty),commission=amount(row?.commission);
  const buyer=row?.isBuyer===true||row?.isBuyer===false?row.isBuyer===true:row?.buyer===true||row?.buyer===false?row.buyer:null;
  if(price===null||qty===null||quoteQty===null||commission===null||qty<=0||price<=0||!assets.has(row?.commissionAsset)||buyer===null)return null;
  const id=String(row.id||''),orderId=String(row.orderId||'');
  if(!/^\d{1,20}$/.test(id)||!/^\d{1,20}$/.test(orderId))return null;
  const time=Number(row.time);
  return {id,orderId,price,qty,quoteQty,commission,commissionAsset:row.commissionAsset,buyer,...(Number.isSafeInteger(time)&&time>0?{time}:{})};
 }).filter(Boolean);
 return {symbol:'BTCUSDT',usdt,usdtLocked,btc,orders,history,trades,...(btcPrice?{btcPrice}:{}),...(bnbPrice?{bnbPrice}:{}),...(equityUsd===null?{}:{equityUsd})};
}
function fillsFromOrders(book){
 const seen=new Set();
 return [...(book?.history||[]),...(book?.orders||[])].map(row=>{
  const qty=Number(row?.executedQty),price=Number(row?.price),quote=Number(row?.cummulativeQuoteQty??row?.cumulativeQuoteQty);
  const orderId=String(row?.orderId||'');
  if(!(qty>0)||seen.has(orderId)||(row?.side!=='BUY'&&row?.side!=='SELL'))return null;
  const quoteQty=Number.isFinite(quote)&&quote>0?quote:price>0?price*qty:0;
  if(!(quoteQty>0))return null;
  seen.add(orderId);
  const time=Number(row.time);
  return {id:orderId,orderId,price:quoteQty/qty,qty,quoteQty,commission:0,commissionAsset:'USDT',buyer:row.side==='BUY',...(Number.isFinite(time)&&time>0?{time}:{})};
 }).filter(Boolean);
}
export function spotTradeLedger(book){
 const traded=[...(book?.trades||[])].filter(row=>row&&row.qty>0&&row.price>0);
 const trades=(traded.length?traded:fillsFromOrders(book)).sort((a,b)=>(a.time||0)-(b.time||0)||String(a.id).localeCompare(String(b.id)));
 if(!trades.length)return null;
 const bnb=boundedAmount(book.bnbPrice)||0;
 let held=0,cost=0,realized=0,fees=0;
 const closes=new Map();
 for(const trade of trades){
  const fee=trade.commissionAsset==='USDT'?trade.commission:trade.commissionAsset==='BTC'?trade.commission*trade.price:trade.commission*bnb;
  fees+=fee;
  if(trade.buyer){
   held+=trade.commissionAsset==='BTC'?Math.max(0,trade.qty-trade.commission):trade.qty;
   cost+=trade.quoteQty+(trade.commissionAsset==='USDT'?trade.commission:0)+(trade.commissionAsset==='BNB'?trade.commission*bnb:0);
  }else{
   const sold=Math.min(trade.qty,held),average=held>0?cost/held:0;
   const proceeds=trade.quoteQty-(trade.commissionAsset==='USDT'?trade.commission:0)-(trade.commissionAsset==='BNB'?trade.commission*bnb:0);
   const pnl=proceeds-average*sold;
   realized+=pnl;
   const id=String(trade.orderId||trade.id);
   closes.set(id,(closes.get(id)||0)+pnl);
   cost=Math.max(0,cost-average*sold);
   held=Math.max(0,held-sold-(trade.commissionAsset==='BTC'?trade.commission:0));
  }
 }
 const mark=boundedAmount(book.btcPrice);
 const current=held>0?mark?held*mark-cost:null:0;
 return {fees:traded.length?fees:null,realized,current,cumulative:current===null?null:realized+current,closes};
}
export function spotBookPerformance(book){
 const ledger=spotTradeLedger(book);
 return ledger?{fees:ledger.fees,realized:ledger.realized,current:ledger.current,cumulative:ledger.cumulative}:null;
}
export function connectionReturnContext(value){
 if(!value||typeof value!=='object'||!['setup','strategy','bot','autonomous'].includes(value.route))return null;
 const context={route:value.route};
 for(const key of ['draftId','runId']){const id=connectionText(value[key],80);if(id&&/^[\w][\w:.-]*$/.test(id))context[key]=id;}
 if(Number.isSafeInteger(value.version)&&value.version>=0)context.version=value.version;
 return context;
}
const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const validChatId=value=>typeof value==='string'&&/^-?[1-9]\d{0,19}$/.test(value);
export function notificationRecipientIssue(preference){
 if(preference?.service==='email'&&!validEmail(typeof preference.email==='string'?preference.email.trim():''))return 'email';
 if(preference?.service==='telegram'&&!validChatId(typeof preference.telegramChatId==='string'?preference.telegramChatId.trim():''))return 'telegramChatId';
 return null;
}
export function safeGatewayURL(value){
 if(typeof value!=='string'||value.length>300)return '';
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash?u.href.replace(/\/$/,''):'';}catch{return '';}
}
export function normalizeConnectionPreferences(input={}){
 input=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
 const p=defaultPreferences();
 for(const type of ['exchange','ai','wallet','notifications'])if(CONNECTION_OPTIONS[type].some(o=>o.id===input[type]?.service))p[type].service=input[type].service;
 for(const [type,key,values]of [['exchange','market',['spot','perp']],['exchange','access',['read','trade']],['wallet','access',['read','confirm']],['ai','model',['balanced','adaptive','fast']],['wallet','network',['evm','solana']],['data','source',['official','custom']],['ai','source',['official','custom']]])if(values.includes(input[type]?.[key]))p[type][key]=input[type][key];
 if(input.ai?.model==='deep')p.ai.model='adaptive';
 if(!input.ai?.source&&input.ai?.service==='gateway')p.ai.source='custom';
 p.ai.agents=normalizeAgentModels(input.ai?.agents,input.ai?.modelId);
 if(['openrouter','gateway'].includes(input.ai?.customService))p.ai.customService=input.ai.customService;
 if(['openrouter','gateway'].includes(input.ai?.service))p.ai.customService=input.ai.service;
 if(p.ai.source==='official')p.ai.service='official';
 else{
  if(p.ai.service==='official')p.ai.service=p.ai.customService;
 }
 p.ai.endpoint=safeGatewayURL(input.ai?.endpoint);
 if(safeModelIdentity(input.ai?.modelId))p.ai.modelId=input.ai.modelId;
 if(Array.isArray(input.data?.services))p.data.services=[...new Set(input.data.services)].filter(id=>CONNECTION_OPTIONS.data.some(o=>o.id===id));
 if(Array.isArray(input.notifications?.events))p.notifications.events=[...new Set(input.notifications.events)].filter(id=>NOTICE_EVENTS.includes(id));
 const email=typeof input.notifications?.email==='string'?input.notifications.email.trim():'';
 const chatId=typeof input.notifications?.telegramChatId==='string'?input.notifications.telegramChatId.trim():'';
 if(validEmail(email))p.notifications.email=email;
 if(validChatId(chatId))p.notifications.telegramChatId=chatId;
 if(input.wallet?.service==='watch')p.wallet.service=p.wallet.network==='solana'?'phantom':'metamask';
 if(p.wallet.service==='metamask')p.wallet.network='evm';
 if(p.wallet.service==='phantom')p.wallet.network='solana';
 if(input.wallet?.venue==='hyperliquid'&&p.wallet.network==='evm')p.wallet.venue='hyperliquid';
 p.wallet.chain=WALLET_NETWORKS.find(n=>n.id===input.wallet?.chain&&n.family===p.wallet.network)?.id||(p.wallet.network==='evm'?'56':'solana:mainnet');
 return p;
}
export function connectionBilling(preferences){
 const p=normalizeConnectionPreferences(preferences);
 return {data:p.data.source==='custom'?'own-api':'credits',ai:p.ai.source==='custom'?'own-api':'credits',automaticFallback:false};
}
export function walletTradingProfile(preference){
 const p=normalizeConnectionPreferences({wallet:preference}).wallet;
 if(p.venue!=='hyperliquid'&&p.chain==='56')return 'dex-spot';
 const network=p.venue==='hyperliquid'?'Hyperliquid':WALLET_NETWORKS.find(n=>n.id===p.chain)?.name;
 return Object.values(ORDER_MARKETS).find(m=>m.venueType==='DEX'&&m.chain===network)?.id||null;
}
export function signedWalletSession(body){
 const session=body?.session??body;
 const address=typeof session?.address==='string'?session.address.toLowerCase():'';
 if(Number(session?.chain)!==56||!/^0x[0-9a-f]{40}$/.test(address))return null;
 return {address,chain:56};
}
export function applySignedWallet(connections,session){
 const base=connections&&typeof connections==='object'&&!Array.isArray(connections)?connections:{};
 const current=tradingConnections(base),address=typeof session?.address==='string'?session.address.toLowerCase():'';
 const signed=session?.chain===56&&/^0x[0-9a-f]{40}$/.test(address);
 const placeholder=record=>record.kind==='wallet'&&record.chain==='56'&&record.venue!=='hyperliquid'&&record.accountId==='SIM-01';
 const kept=current.filter(record=>record.id!=='wallet-bsc'&&!(signed&&placeholder(record))),existing=current.find(record=>record.id==='wallet-bsc');
 if(!signed){
  if(!existing)return base;
  const preferred=base.preferredTradingConnection==='wallet-bsc'?'':base.preferredTradingConnection||'';
  return {...base,tradingAccounts:kept,preferredTradingConnection:kept.some(record=>record.id===preferred)?preferred:''};
 }
 if(!current.some(placeholder)&&existing?.accountId===address&&existing.chain==='56'&&existing.status==='connected'&&existing.service==='metamask'&&existing.venue==='wallet')return base;
 const wallet={id:'wallet-bsc',kind:'wallet',service:'metamask',network:'evm',chain:'56',venue:'wallet',access:'confirm',accountId:address,label:address.slice(0,6)+'…'+address.slice(-4),status:'connected',checkedAt:existing?.accountId===address&&existing.checkedAt||1};
 const preferred=kept.some(record=>record.id===base.preferredTradingConnection)?base.preferredTradingConnection:'';
 return {...base,tradingAccounts:[...kept,wallet],preferredTradingConnection:preferred};
}
export function connectionPreviewIssue(type,pref,scenario='normal'){
 if(scenario==='timeout')return 'timeout';
 if(type==='exchange'){
  if(scenario==='withdraw')return 'withdraw';
  if(scenario==='read-missing'||scenario==='trade-missing'&&pref.access==='trade')return 'permissions';
  if(scenario==='no-ip'&&pref.access==='trade')return 'ip';
 }else if(type==='wallet'){
  if(scenario==='refused')return 'refused';
  if(scenario==='network')return 'network';
 }
 return null;
}
export const connectionReviewKey=(type,pref,budget)=>JSON.stringify([type,normalizeConnectionPreferences({[type]:pref})[type],type==='ai'?budget:null]);
const liveCredentialText=value=>typeof value==='string'&&value.length>=8&&value.length<=256&&!/[\s\u0000-\u001f]/.test(value);
export function apiCredentialIssue(option,values){
 if(option?.id==='binance'&&option.venue==='binance'){
  if(option.fields.some(key=>/^demo-/.test(values[key]||'')))return 'live-required';
  return option.fields.some(key=>!liveCredentialText(values[key]||''))?'invalid-credentials':null;
 }
 return demoCredentialIssue(option,values);
}
export function demoCredentialIssue(option,values){
 return option.fields.some(key=>!/^demo-[a-zA-Z0-9-]{3,80}$/.test(values[key]||''))?'demo-only':null;
}
export function notificationAllowed(connections,event){
 if(!connections?.notifications)return false;
 const p=normalizeConnectionPreferences(connections.preferences).notifications;
 // External delivery is not connected; the separate in-app switch remains effective.
 return p.events.includes(event?.kind==='research'?'research':['order','fill','signal'].includes(event?.kind)?'orders':'risk');
}
