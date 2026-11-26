// Local, deterministic helpers. No model, network, order or credit side effects.
import {MARKET,NEWS,SNAPSHOT} from './data-center-fixtures.mjs';
import {CATALOG} from './strategy-catalog.mjs';
import {strategyPlan} from './strategy-execution-data.mjs';
import {TRACKING_CASES} from './signal-tracking.mjs';
import {makeBars} from './product-chart-ui.mjs';
import {CANDLE_PERIODS,candleRequest} from './trading-chart-data.mjs';
import {HUB_SYMBOLS} from './market-hub-data.mjs';
import {TOKEN_IDS} from './brand-icon-data.mjs';
import {assistantQuoteInstrument,cleanAssistantQuote,MAX_ASSISTANT_QUOTES} from './assistant-exchange-data.mjs';
const assetPattern=new RegExp('\\b(?:'+MARKET.map(a=>a.symbol).filter(s=>/^[A-Z0-9]+$/.test(s)).join('|')+')\\b','gi');
export const CHAT_LIMITS={threads:12,turns:24,sources:6,sourceLength:6000,questionLength:2000,fileBytes:65536};
export const BINANCE_AGENT_OS={
 id:'binance-agent-os',url:'https://www.binance.com/agent-os',docs:'https://developers.binance.com/en/docs/agent-native/mcp-server/agentic',
 tasks:{
  market:{label:['行情研究','Market research'],detail:['价格、盘口、K线与资金费率','Price, order book, candles and funding'],prompt:['用 Binance 数据研究 BTC 的行情、成交与关键价位','Research BTC price, trading activity and key levels with Binance data'],icon:'chart',page:'markets'},
  account:{label:['账户与持仓','Account & positions'],detail:['只读查看资产、持仓与成交','Read-only balances, positions and fills'],prompt:['分析我所选 Binance 账户的持仓、集中度与风险敞口','Review positions, concentration and exposure in my selected Binance account'],icon:'shield',page:'assets'},
  onchain:{label:['链上研究','On-chain research'],detail:['代币风险、地址与资金流','Token risk, addresses and fund flows'],prompt:['用 Binance 链上工具检查 ETH 的资金流和代币风险','Use Binance on-chain tools to review ETH fund flows and token risk'],icon:'pulse',page:'tracking'},
  plan:{label:['交易预案','Trade plan'],detail:['周期、入场、退出与资金保护','Timeframe, entry, exit and capital protection'],prompt:['结合策略库整理 BTC 交易预案，列出周期、入场、退出、止损和止盈条件，先不下单','Build a BTC trade plan from the strategy library with timeframe, entry, exit, stop and take-profit conditions, without placing an order'],icon:'strategy',page:'strategies'}
 }
};
export const ASSISTANT_TOOLSETS=[
 {id:'workspace',label:['工作空间','Workspace'],available:true,icon:'strategy',tasks:{
  sources:{label:['添加资料','Add a source'],icon:'attach'},
  material:{label:['投研报告','Research report'],icon:'file'},
  technical:{label:['解读行情','Read a chart'],icon:'chart'}
 }},
 {id:BINANCE_AGENT_OS.id,label:['Binance','Binance'],available:true,exchange:true,brand:'binance',docs:BINANCE_AGENT_OS.docs,tasks:{
  market:{label:['行情研究','Market research'],icon:'chart'},
  account:{label:['账户与持仓','Account & positions'],icon:'shield'},
  trades:{label:['成交记录','Trade history'],icon:'file'},
  plan:{label:['行情分析','Market analysis'],icon:'strategy'}
 }}
];
const providerTask=value=>typeof value==='string'&&Object.hasOwn(BINANCE_AGENT_OS.tasks,value)?value:null;
export const clipText=(value,n=CHAT_LIMITS.sourceLength)=>String(value??'').replace(/\u0000/g,'').slice(0,n).trim();
export function cleanSource(source={}){
 if(!source||typeof source!=='object'||typeof source.text!=='string')return null;
 const text=clipText(source.text);if(!text)return null;
 const href=typeof source.href==='string'&&/^\?page=[a-z-]+(?:&[a-z][a-z_]*=[\w.%+:-]+)*$/.test(source.href)?source.href:'';
 return {id:clipText(source.id||source.title||'source',100),title:clipText(source.title||'资料',100),text,href,kind:['market','news','chain','excerpt','file'].includes(source.kind)?source.kind:'excerpt',
  ...(source.private===true||source.scope==='private'?{scope:'private'}:{})};
}
export function addSource(sources,source){
 const item=cleanSource(source);if(!item)return {sources,error:'empty'};
 if(sources.some(x=>x.text===item.text&&x.title===item.title))return {sources,error:'duplicate'};
 if(sources.length>=CHAT_LIMITS.sources)return {sources,error:'limit'};
 return {sources:[...sources,item],error:null};
}
export function sourceNeedsNewThread(thread){
 return !!(thread.draft?.trim()||thread.turns?.length||thread.sources?.length||thread.providerTask||thread.mode!=='ask');
}
export function analyzeBars(bars){
 if(!Array.isArray(bars)||bars.length<8)throw new Error('Need at least 8 complete bars');
 if(bars.some(b=>![b.open,b.high,b.low,b.close,b.time].every(Number.isFinite)||b.low<=0||b.high<Math.max(b.open,b.close,b.low)||b.low>Math.min(b.open,b.close)))throw new Error('Invalid OHLC');
 const closes=bars.map(b=>b.close),first=bars[0],last=bars.at(-1),mean=n=>closes.slice(-Math.min(n,closes.length)).reduce((a,b)=>a+b,0)/Math.min(n,closes.length);
 let rsi=null;
 if(closes.length>=15){
  let gain=0,loss=0;for(let i=1;i<=14;i++){const d=closes[i]-closes[i-1];gain+=Math.max(0,d)/14;loss+=Math.max(0,-d)/14;}
  for(let i=15;i<closes.length;i++){const d=closes[i]-closes[i-1];gain=(gain*13+Math.max(0,d))/14;loss=(loss*13+Math.max(0,-d))/14;}
  rsi=gain===0&&loss===0?50:loss===0?100:100-100/(1+gain/loss);
 }
 const ma5=mean(5),ma20=mean(20),span=Math.max(...bars.map(b=>b.high))-Math.min(...bars.map(b=>b.low));
 const tolerance=last.close*.0005,trend=ma5>ma20+tolerance&&last.close>ma20?'rising':ma5<ma20-tolerance&&last.close<ma20?'falling':'range';
 return {count:bars.length,start:first.time,end:last.time,open:first.open,close:last.close,change:(last.close/first.open-1)*100,high:Math.max(...bars.map(b=>b.high)),low:Math.min(...bars.map(b=>b.low)),ma5,ma20,rsi,trend,rangePct:span/first.open*100};
}
export function extractMaterial(sources){
 const cleaned=sources.map(cleanSource).filter(Boolean).slice(0,CHAT_LIMITS.sources);
 const assets=[...new Set(cleaned.flatMap(s=>(s.text+' '+s.title).match(assetPattern)||[]).map(x=>x.toUpperCase()))];
 const claims=cleaned.flatMap((s,index)=>s.text.split(/(?<=[。！？!?\n])\s*/u).filter(t=>t.trim().length>5&&!/^\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?$/.test(t.trim())).slice(0,2).map(text=>({source:index,title:s.title,text:clipText(text,240)}))).slice(0,8);
 const numbers=[...new Set(cleaned.flatMap(s=>s.text.replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g,'').replace(/\b\d+[hHdD]\b/g,'').match(/(?:\$\s*)?[+-]?\d[\d,]*(?:\.\d+)?\s*(?:%|bps?|BTC|ETH|SOL|USDT|million\s+USD|billion\s+USD|USD|万|亿|百万|分钟|小时|天)?/g)||[]))].slice(0,8);
 const hasTransfer=cleaned.some(s=>/转账|转入|转出|transfer|inflow|outflow/i.test(s.text));
 return {sources:cleaned.length,characters:cleaned.reduce((n,s)=>n+s.text.length,0),assets,claims,numbers,hasTransfer};
}
export function questionTopic(question){
 const q=String(question);if(/积分|credit|cost|收费|クレジット|ポイント|크레딧|포인트|비용|điểm|chi phí|crédit|coût|кредит|стоимост/i.test(q))return 'credits';
 const news=/新闻|消息|宏观|news|macro|fed|ニュース|マクロ|뉴스|거시|tin tức|vĩ mô|noticia|actualit|новост|макро/i.test(q);
 // Event risk is news context; explicit stop-loss and capital-protection requests keep their action.
 if(news&&!/止损|保护|资金上限|stop.?loss|protect|spending limit|損切|保護|손절|보호|bảo vệ|cắt lỗ|protección|stop|защит|стоп/i.test(q))return 'news';
 if(/风险|保护|止损|risk|loss|stop|リスク|損失|損切|위험|손실|손절|rủi ro|riesgo|pérdida|protección|risque|perte|protection|риск|убыт|защит|стоп/i.test(q))return 'risk';
 if(/策略|均线|RSI|strategy|indicator|moving average|戦略|移動平均|전략|지표|chiến lược|chỉ báo|estrategia|indicador|stratégie|indicateur|стратег|индикатор/i.test(q))return 'strategy';
 if(news)return 'news';
 if(/地址|转账|链上|wallet|chain|transfer|アドレス|ウォレット|送金|オンチェーン|주소|지갑|온체인|송금|địa chỉ|trên chuỗi|chuyển token|billetera|cartera|dirección|adresse|portefeuille|chaîne|адрес|кошел|блокчейн|перевод/i.test(q))return 'chain';
 if(/赚钱|收益|保证|guarantee|profit|利益|儲|保証|수익|보장|lợi nhuận|đảm bảo|beneficio|rentabilidad|garanti|bénéfice|rendement|прибыл|доход|гарант/i.test(q))return 'returns';
 if(new RegExp(assetPattern.source,'i').test(q)||/比特币|以太坊|黄金|bitcoin|ethereum|solana/i.test(q)||/价格|行情|报价|k\s*线|price|quote|candle|chart|盘口|资金费率/i.test(q))return 'market';
 return 'help';
}
export function questionLanguage(question){
 const text=String(question||'');
 if(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text))return '';
 return /[A-Za-z]/.test(text)?'en':'';
}
export const orderRuleQuestion=q=>/限[价價][单單]|市[价價][单單]|\b(?:limit|market)[ -]+orders?\b/i.test(q);
const quoteAliases={BTC:['比特币','比特幣','大饼','大餅'],ETH:['以太坊','以太幣','以太币','以太'],SOL:['索拉纳','索拉納'],BNB:['币安币','幣安幣'],DOGE:['狗狗币','狗狗幣'],XAU:['黄金','黃金','gold'],SPX:['标普','標普','S&P 500'],NDX:['纳指','納指','纳斯达克','納斯達克','Nasdaq 100'],DXY:['美元指数','美元指數','US Dollar Index'],US10Y:['美债十年','美債十年','10-year Treasury']};
const quoteSymbols=[...new Set([...HUB_SYMBOLS,...MARKET.map(a=>a.symbol),...Object.values(TOKEN_IDS)])];
const marketNames=quoteSymbols.map(symbol=>{
 const names=[symbol,MARKET.find(a=>a.symbol===symbol)?.name,...(quoteAliases[symbol]||[])].filter(Boolean);
 const pattern=names.map(name=>/^[\x20-\x7e]+$/.test(name)?'\\b'+name.replace(/[.*+?^{}$()|[\]\\]/g,'\\$&')+'\\b':name).join('|');
 return [symbol,new RegExp(pattern,'i')];
});
export function isAssetOnlyReply(question){
 if(!questionQuoteSymbols(question).length)return false;
 let rest=question.replace(/\b([A-Z0-9]+?)(?:[/-]?(?:USDT|USDC|USD))\b/gi,'$1');
 for(const [,pattern] of marketNames)rest=rest.replace(pattern,' ');
 return !rest.replace(/我说的是|我指的是|指的是|看一下|看看|就是|请看|那|是|和|与|及|呢|吧|\b(?:and|the|please|I mean|I meant)\b|[\s,，、。.!?！？&+]/gi,'');
}
export function questionQuoteSymbols(question,topic='market'){
 if(orderRuleQuestion(question)||/样例|示例|示範|示范|历史|歷史|昨天|昨日|上周|去年|20\d\d[-年/]|historical|example|yesterday|last week|OKX|Bybit|Coinbase|Kraken|合约|永续|期货|futures|perpetual|资金费率|持仓量|盘口|funding rate|open interest|order ?book/i.test(question))return [];
 if(topic!=='market'&&(!/价格|现价|市价|走势|行情|报价|price|quote|how much.*cost/i.test(question)||/积分|费用|收费|credits?|fees?/i.test(question)))return [];
 let mismatch=false;
 const text=question.replace(/\b([A-Z0-9]{2,12})[/-]([A-Z]{2,6})\b|\b([A-Z0-9]{2,12})((?:USDT|USDC|USD))\b/gi,(match,base,quote,compact,unit)=>{
  const symbol=(base||compact).toUpperCase(),requested=(quote||unit).toUpperCase(),instrument=assistantQuoteInstrument(symbol);
  if(!instrument||instrument.market!==symbol+'/'+requested)mismatch=true;
  return symbol;
 });
 if(mismatch)return [];
 const symbols=marketNames.filter(([,pattern])=>pattern.test(text)).map(([symbol])=>symbol);
 if(symbols.length)return symbols.length<=MAX_ASSISTANT_QUOTES?symbols:[];
 return /^(?:(?:现在|今天|当前|最新|最近|看看|看下|请问|一下|的)\s*)*(?:行情|市场行情|市场|币市|大盘)(?:怎么样|如何|走势|表现|概况|行情|情况|分析|呢|吗|[？，。？！?\s])*$|^(?:how (?:is|are) (?:the )?(?:crypto )?markets?(?: doing)?(?: today)?|(?:current |latest |today.s )?(?:crypto )?market (?:overview|update|summary)(?: today)?)[?.!\s]*$/i.test(text.trim())?['BTC','ETH','SOL']:[];
}
export function technicalIntent(question){
 const q=String(question);
 if(/RSI|相对强弱|超买|超卖|过热|动量|momentum|overbought|oversold/i.test(q))return 'rsi';
 if(/止损|止盈|风险|risk|stop.?loss|take.?profit|損切|위험|rủi ro|riesgo|risque|риск/i.test(q))return 'risk';
 if(/支撑|阻力|关键.*[位价]|价位|support|resistance|levels|支持|저항|hỗ trợ|soporte|résistance|поддерж/i.test(q))return 'levels';
 if(/新闻|消息|舆情|宏观|news|macro|sentiment|ニュース|뉴스|tin tức|noticia|actualit|новост/i.test(q))return 'news';
 if(/MACD|布林|bollinger|VWAP|ATR|EMA|MA\s*(50|100|200)\b/i.test(q))return 'unsupported';
 if(/趋势|均线|MA\s*(5|20)\b|trend|moving average|トレンド|추세|xu hướng|tendencia|tendance|тренд/i.test(q))return 'trend';
 return 'overview';
}

export const RESEARCH_AS_OF=Date.parse(SNAPSHOT.replace(' ','T')+':00+08:00');
export const RESEARCH_OPTIONS={
 scopes:{assets:['交易标的','Assets'],sectors:['赛道板块','Sectors'],market:['全市场','All markets']},
 focus:{overview:['市场综览','Market overview'],technical:['技术结构','Technical structure'],news:['消息与资金','News & flows'],strategy:['策略适用性','Strategy fit']},
 sectors:{PoW:['PoW','PoW'],'Layer 1':['Layer 1','Layer 1'],'Layer 2':['Layer 2','Layer 2'],DeFi:['DeFi','DeFi'],AI:['AI','AI'],Meme:['Meme','Meme'],'支付':['支付','Payments'],TradFi:['传统资产','Traditional assets']}
};
export const researchDate=time=>new Date(time+8*3600000).toISOString().slice(0,16);
const researchTime=value=>{
 if(typeof value!=='string'||!/^20\d\d-\d\d-\d\dT\d\d:\d\d$/.test(value))return NaN;
 const time=Date.parse(value+':00+08:00');return Number.isFinite(time)&&researchDate(time)===value?time:NaN;
};
const unique=(values,allowed,limit)=>[...new Set(values.filter(x=>allowed.includes(x)))].slice(0,limit);
export function normalizeResearchConfig(value={}){
 const window=['24h','7d','30d','custom'].includes(value.window)?value.window:'24h';
 const end=typeof value.end==='string'?value.end.slice(0,16):researchDate(RESEARCH_AS_OF),endTime=researchTime(end);
 return {scope:Object.hasOwn(RESEARCH_OPTIONS.scopes,value.scope)?value.scope:'assets',assets:Array.isArray(value.assets)?unique(value.assets,MARKET.map(a=>a.symbol),5):['BTC','ETH','SOL'],sectors:Array.isArray(value.sectors)?unique(value.sectors,Object.keys(RESEARCH_OPTIONS.sectors),3):['AI'],window,
  start:window==='custom'?(typeof value.start==='string'?value.start.slice(0,16):researchDate(RESEARCH_AS_OF-86400000)):Number.isFinite(endTime)?researchDate(endTime-({'24h':1,'7d':7,'30d':30}[window])*86400000):'',end,
  focus:Object.hasOwn(RESEARCH_OPTIONS.focus,value.focus)?value.focus:'overview',depth:value.depth==='full'?'full':'brief'};
}
export function researchRange(value){
 const config=normalizeResearchConfig(value),start=researchTime(config.start),end=researchTime(config.end);
 if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)throw new Error('research-time');
 return {start,end};
}
export function researchAssets(value){
 const c=normalizeResearchConfig(value);return MARKET.filter(a=>c.scope==='market'||(c.scope==='sectors'?c.sectors.includes(a.sector):c.assets.includes(a.symbol)));
}
const eventTime=item=>Date.parse(`${item.date}T${item.time}:00+08:00`);
export function technicalContext(technical){
 if(!technical)return {news:[],signals:[]};const {start,end}=technical,symbols=new Set(technical.assets||[technical.asset]),seen=new Set();
 return {
  news:NEWS.filter(item=>item.assets.some(a=>symbols.has(a))&&eventTime(item)>=start&&eventTime(item)<=end).sort((a,b)=>eventTime(b)-eventTime(a)).map(item=>({id:item.id,title:item.title,body:item.body||item.title,impact:item.impact||'',at:eventTime(item),assets:item.assets.filter(a=>symbols.has(a)),href:'?page=intelligence&story='+item.id})).slice(0,6),
  signals:TRACKING_CASES.filter(item=>symbols.has(item.asset.symbol)).flatMap(item=>item.events).filter(item=>eventTime(item)>=start&&eventTime(item)<=end).sort((a,b)=>eventTime(b)-eventTime(a)).filter(item=>{const key=item.symbol+'|'+item.title[0];if(seen.has(key))return false;seen.add(key);return true;}).slice(0,8).map(item=>({id:item.id,asset:item.symbol,title:item.title,reason:item.reason,at:eventTime(item),href:'?page=signals&asset='+item.symbol}))
 };
}
export function buildResearchReport(value){
 const config=normalizeResearchConfig(value),{start,end}=researchRange(config),assets=researchAssets(config);if(!assets.length)throw new Error('research-assets');
 const rows=assets.map(asset=>{
  const all=makeBars(asset.series,'1H'),bars=all.filter(b=>b.time-3600000>=start&&b.time<=end);
  return {asset:asset.symbol,unit:asset.unit,sector:asset.sector,count:bars.length,coverage:bars.length?(bars[0].time-3600000>start||bars.at(-1).time<end?'partial':'full'):'none',analysis:bars.length>=8?{...analyzeBars(bars),start:bars[0].time-3600000}:null,volume24h:end>=RESEARCH_AS_OF&&start<=RESEARCH_AS_OF?asset.volume:null};
 }).sort((a,b)=>(b.volume24h??0)-(a.volume24h??0));
 const evidence=technicalContext({start,end,assets:assets.map(a=>a.symbol)});
 const limit=config.depth==='full'?6:3,candidates=CATALOG.map(strategy=>({strategy,plan:strategyPlan(strategy.id)})),groups=assets.map(asset=>candidates.filter(({strategy,plan})=>plan?.symbol===asset.symbol&&strategy.market.includes(asset.symbol+'USDT')));
 const strategies=Array.from({length:limit},(_,i)=>groups.flatMap(group=>group[i]?[group[i]]:[])).flat().slice(0,limit).map(({strategy:s,plan:p})=>({id:s.id,name:s.name,timeframe:s.timeframe,entry:p.entry,exit:p.exit,need:p.need,symbol:p.symbol,version:p.baseVersion,nativeAccepted:p.nativeAccepted===true,href:'?page=strategies'}));
 return {version:1,sample:true,config,asOf:RESEARCH_AS_OF,rows,news:evidence.news,signals:evidence.signals,strategies};
}
const textPair=(value,n=800)=>Array.isArray(value)?value.slice(0,2).map(v=>clipText(v,n)):['',''];
function cleanTechnical(value){
 if(!value||![value.start,value.end,value.open,value.close,value.low,value.high,value.ma5,value.ma20,value.change,value.rangePct,value.count].every(Number.isFinite)||!Number.isInteger(value.count)||value.count<8||value.count>10000||value.end<value.start||value.low<=0||value.high<value.low)return null;
 const bars=Array.isArray(value.bars)&&value.bars.length===value.count&&value.bars[0]?.time===value.start&&value.bars.at(-1)?.time===value.end&&value.bars.every((b,i)=>b&&[b.time,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)&&b.low>0&&b.volume>=0&&b.high>=Math.max(b.open,b.close,b.low)&&b.low<=Math.min(b.open,b.close)&&(!i||b.time>value.bars[i-1].time))?value.bars.map(b=>Object.fromEntries(['time','open','high','low','close','volume'].map(k=>[k,b[k]]))):[];
 const live=value.clockKind==='wall';if(live&&(!candleRequest(value)||value.market!==value.asset+'/USDT'||value.provider!=='Binance Spot'||!Number.isFinite(value.asOf)||!bars.length))return null;
 return {...Object.fromEntries(['start','end','open','close','low','high','ma5','ma20','change','rangePct','count'].map(key=>[key,value[key]])),rsi:Number.isFinite(value.rsi)&&value.rsi>=0&&value.rsi<=100?value.rsi:null,trend:['rising','falling','range'].includes(value.trend)?value.trend:'range',asset:clipText(value.asset,12),period:Object.hasOwn(CANDLE_PERIODS,value.period)?value.period:'1H',clockKind:live?'wall':'historical',provider:live?'Binance Spot':'Astarter fixture',precision:live?'candle':'hour',...(live?{market:value.market,venueId:value.venueId,profileId:value.profileId,asOf:value.asOf,capturedAt:Number.isFinite(value.capturedAt)?value.capturedAt:value.asOf}:{}),bars};
}
function cleanContext(value){
 const news=(Array.isArray(value?.news)?value.news:[]).filter(x=>x&&Number.isFinite(x.at)).slice(0,6).map(x=>({id:clipText(x.id,100),title:clipText(x.title,240),body:clipText(x.body,1000),impact:clipText(x.impact,400),at:x.at,assets:Array.isArray(x.assets)?unique(x.assets,MARKET.map(a=>a.symbol),40):[],href:cleanSource({text:'x',href:x.href}).href}));
 const signals=(Array.isArray(value?.signals)?value.signals:[]).filter(x=>x&&Number.isFinite(x.at)).slice(0,8).map(x=>({id:clipText(x.id,100),asset:clipText(x.asset,12),title:textPair(x.title,240),reason:textPair(x.reason,600),at:x.at,href:cleanSource({text:'x',href:x.href}).href}));
 return {news,signals};
}
export function normalizeResearchReport(value){
 if(value?.version!==1||value.sample!==true||!Array.isArray(value.rows)||!Number.isFinite(value.asOf))return null;
 return {version:1,sample:true,config:normalizeResearchConfig(value.config),asOf:value.asOf,rows:value.rows.filter(r=>r&&MARKET.some(a=>a.symbol===r.asset)).slice(0,40).map(r=>({asset:r.asset,unit:clipText(r.unit,20),sector:clipText(r.sector,30),count:Number.isInteger(r.count)&&r.count>=0?r.count:0,coverage:['none','partial','full'].includes(r.coverage)?r.coverage:'none',analysis:cleanTechnical(r.analysis),volume24h:Number.isFinite(r.volume24h)&&r.volume24h>=0?r.volume24h:null})),...cleanContext(value),
  strategies:(Array.isArray(value.strategies)?value.strategies:[]).filter(s=>s&&CATALOG.some(c=>c.id===s.id)).slice(0,6).map(s=>({id:s.id,name:clipText(s.name,100),timeframe:clipText(s.timeframe,120),entry:textPair(s.entry),exit:textPair(s.exit),need:textPair(s.need),symbol:clipText(s.symbol,12),version:clipText(s.version,100),nativeAccepted:s.nativeAccepted===true,href:'?page=strategies'}))};
}

export function cleanSharedOutput(value){
 if(value?.version!==1||value.sample!==true||typeof value.title!=='string'||typeof value.text!=='string'||!value.text.trim()||value.text.length>16000)return null;
 const sources=(Array.isArray(value.sources)?value.sources:[]).slice(0,12).map(source=>{
  const href=cleanSource({text:'x',href:source?.href}).href,params=new URLSearchParams(href),keys=[...params.keys()];
  if(!['markets','intelligence','signals','strategies'].includes(params.get('page'))||new Set(keys).size!==keys.length||keys.some(key=>!['page','asset','story'].includes(key))||params.has('asset')&&!MARKET.some(a=>a.symbol===params.get('asset'))||params.has('story')&&!NEWS.some(n=>n.id===params.get('story')))return null;
  return {title:clipText(source?.title,100),href};
 }).filter(source=>source?.title&&source.href);
 return {version:1,sample:true,title:clipText(value.title,120),text:clipText(value.text,16000),mode:['ask','material','technical'].includes(value.mode)?value.mode:'ask',asOf:Number.isFinite(value.asOf)?value.asOf:RESEARCH_AS_OF,sources};
}
export async function encodeSharedOutput(value){
 const output=cleanSharedOutput(value);if(!output)throw new Error('share-content');
 let bytes=new TextEncoder().encode(JSON.stringify(output)),prefix='v1.';
 if(typeof CompressionStream!=='undefined'){bytes=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());prefix='v1z.';}
 const token=prefix+btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');if(token.length>12000)throw new Error('share-size');return token;
}
export async function decodeSharedOutput(token){
 if(typeof token!=='string'||token.length>12000||!/^v1z?\.[A-Za-z0-9_-]+$/.test(token))throw new Error('share-link');
 const [version,payload]=token.split('.');let bytes=Uint8Array.from(atob(payload.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
 if(version==='v1z'){
  const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader(),chunks=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>80000)throw new Error('share-size');chunks.push(value);}}finally{await reader.cancel();}
  bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 }
 if(bytes.length>80000)throw new Error('share-size');const output=cleanSharedOutput(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));if(!output)throw new Error('share-content');return output;
}
export function sharedOutputURL(origin,token,invite){
 if(typeof token!=='string'||token.length>12000||!/^v1z?\.[A-Za-z0-9_-]+$/.test(token))throw new Error('share-link');
 if(typeof invite!=='string'||!/^[A-Za-z0-9_-]{4,32}$/.test(invite))throw new Error('share-invite');
 const url=new URL(origin);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('share-origin');
 url.pathname='/chat';url.search=new URLSearchParams({ref:invite}).toString();url.hash='astarter-share='+token;return url.href;
}
export function socialDraft(output,url,channel){
 // shortcut: conservative draft weights; use twitter-text when public X posting is enabled.
 const fit=(text,limit)=>{let result='',weight=0;for(const char of text){const next=char.codePointAt(0)<128?1:2;if(weight+next>limit-2)return result+'…';result+=char;weight+=next;}return result;};
 return (channel==='x'?fit(output.title,60)+'\n'+fit(output.text,150):output.title+'\n'+output.text)+'\n\nASTARTER · DEMO\n'+url;
}
const recallFields={
 code:/代号|代號|暗号|暗號|标记|標記|口令|\b(?:codename|codeword|code word|code name|code|marker)\b/i,
 name:/名字|姓名|称呼|稱呼|\bname\b/i,
 preference:/偏好|喜好|\bpreferences?\b/i,
 budget:/预算(?:上限)?|預算(?:上限)?|\bbudget(?: limit)?\b/i
};
const wrappedRecallValue=[['「','」'],['『','』'],['“','”'],['"','"'],['‘','’'],["'","'"],['`','`']];
const repeatLast=/^(?:(?:请(?:你)?|原样|逐字)*(?:复述|重复)(?:一下)?我(?:的)?上(?:一)?(?:条(?:消息)?|句话?)(?:的原文|的原话)?|(?:请(?:你)?|原样|逐字)?(?:重复|复述|告诉我)?(?:我(?:的)?(?:上(?:一)?(?:条(?:消息)?|句)|刚才)(?:说|发|写)(?:的)?(?:了)?(?:什么|什么内容)|我(?:的)?上(?:一)?(?:条(?:消息)?|句)(?:说的)?(?:是)?什么|我(?:的)?上(?:一)?(?:条消息|句话)(?:的)?原话)|(?:what (?:did i (?:just |last )?(?:say|write|send)(?: in my (?:last|previous) message)?|was my (?:last|previous) message)|(?:please )?(?:repeat|quote) my (?:last|previous) message(?: verbatim)?))$/i;
const recallRequest=/什么|多少|啥|还记得|复述|重复|告诉我|说出|^what\b|\b(?:recall|remind|repeat|tell me|remember)\b/i;
const recallFiller=/上(?:一)?条(?:消息)?|上一轮|本(?:轮|次|次对话)|这(?:一轮|轮|次|段)(?:对话)?|曾经|之前|刚才|临时|对话|消息|请问|请你|麻烦|请|还记得|记得|记住|记下|我|你|给|让|刚|说过|说|提到|留|发|设定|设置|告诉|能否|是否|帮|再|的|是|为|叫|什么|多少|啥|吗|呢|复述|重复|说出|\b(?:what|was|is|did|do|you|i|my|the|a|our|this|that|temporary|session|conversation|last|previous|message|just|earlier|have|had|to|of|as|me|tell|ask|asked|say|said|give|gave|set|assigned|choose|chose|mention|mentioned|remember|remind|recall|repeat|please)\b|[\s'’?,.，。？！：:]/gi;

function recallDeclaration(message,field){
 const lead=/^(?:(?:请(?:你)?|麻烦(?:你)?)?(?:帮我)?(?:记住|记下|记一下|记着)|(?:please\s+)?remember\b)\s*[,，:：]?\s*/i.exec(message);
 if(!lead)return undefined;
 const declaration=message.slice(lead[0].length).replace(/^(?:(?:这(?:一轮|轮|次|段)|本(?:轮|次|次的))(?:对话)?(?:的)?|对话的|临时|我的|我(?:的)?(?:新的)?(?=代号|标记|预算|名字|偏好)|(?:that|my|the|temporary)\b|\s)+/i,'');
 const alternate=field==='name'?/^(?:我叫|叫我|call me\b)/i:field==='preference'?/^(?:我(?:更)?喜欢|我(?:更)?喜歡|I prefer\b)/i:null;
 const start=alternate?.exec(declaration)||recallFields[field].exec(declaration);
 if(!start||start.index!==0)return undefined;
 const rest=declaration.slice(start[0].length).replace(/^\s*(?:是|为|為|叫|设为|改为|改成|设置为|(?:is|was|to)\b|[：:=])?\s*/i,'');
 const wrapper=wrappedRecallValue.find(([open])=>rest.startsWith(open));
 let value;
 if(wrapper){
  const end=rest.indexOf(wrapper[1],1);
  if(end<1||/^\s*(?:或|还是|or\b)/i.test(rest.slice(end+1)))return null;
  value=rest.slice(1,end);
 }else{
  value=rest.split(/[。！？!?；;\n]|\.(?=\s|$)|[,，]\s*(?:然后|再|请|then\b|and (?:tell|explain|answer)\b)/i)[0].trim();
  if(/或(?:者)?|还没决定|未定|\b(?:or|undecided|maybe)\b|(?:[,，]|\band\b)\s*(?:我的|my\b)/i.test(value))return null;
 }
 return value&&value.length<=200?value:null;
}

// Read only user-authored messages in the selected thread; model replies and source material are never evidence here.
export function explicitThreadRecall(question,turns){
 const q=String(question).trim().replace(/(?:[？?。.!，,]\s*|\s+)(?:(?:请)?只(?:需|要|用)?(?:回复|写|输出|回答).{0,20}|(?:please )?(?:only (?:the|reply|answer|return|write)|(?:reply|answer) (?:only|with just)).{0,28})[。.!？?\s]*$/i,'').replace(/[。.!？?\s]+$/,'').replace(/[’']s\b/gi,' is');
 const prior=turns.filter(t=>t?.mode==='ask'&&!t.generatedQuestion&&!t.providerTask&&!t.billingJob&&typeof t.question==='string');
 if(repeatLast.test(q))return prior.at(-1)?.question||null;
 if(!recallRequest.test(q)||!/(?:我|你还记得|之前|刚才|\b(?:i|my|our|gave|did i|previous)\b)/i.test(q))return null;
 const probe=q.replace(/\bcode name\b/gi,'codename');
 const fields=Object.keys(recallFields).filter(k=>recallFields[k].test(probe));
 if(fields.length!==1||probe.replace(recallFields[fields[0]],'').replace(recallFiller,''))return null;
 const field=fields[0],values=new Set();
 for(const turn of prior.slice().reverse()){
  const line=turn.question.trim();
  if(recallFields[field].test(line)&&/^(?:请)?(?:忘掉|忘记|清除|删除)|^(?:please )?forget\b/i.test(line))break;
  const value=recallDeclaration(line,field);
  if(value===null)break;
  if(value!==undefined)values.add(value);
 }
 return values.size===1?[...values][0]:null;
}

function restoredMarketContext(turn){
 const context=turn.marketContext;
 // Earlier saves wrote these empty arrays even when a chat had no market context.
 if(turn.mode==='ask'&&(context==null || (Array.isArray(context.news)&&context.news.length===0 &&
   Array.isArray(context.signals)&&context.signals.length===0&&Object.keys(context).length===2)))return null;
 return cleanContext(context);
}
export function normalizeChatStore(value){
 if(value?.schema!==1||!Array.isArray(value.threads))return {schema:1,threads:[],active:''};
 let standardCount=0;
 const legacyKeys=new Set();
 const threads=value.threads.filter(t=>{
  if(!t||typeof t.id!=='string'||!Array.isArray(t.turns))return false;
  if(!t.legacyLiteKey)return ++standardCount<=CHAT_LIMITS.threads;
  if(typeof t.legacyLiteKey!=='string'||legacyKeys.has(t.legacyLiteKey)||legacyKeys.size>=12)return false;
  legacyKeys.add(t.legacyLiteKey);return true;
 }).map(t=>({
  ...(t.legacyLiteKey?{legacyLiteKey:clipText(t.legacyLiteKey,120)}:{}),
  id:clipText(t.id,100),title:clipText(t.title,80),at:Number.isFinite(t.at)?t.at:0,pinned:!!t.pinned,providerTask:providerTask(t.providerTask),
  mode:['ask','material','technical'].includes(t.mode)?t.mode:'ask',draft:clipText(t.draft,CHAT_LIMITS.questionLength),
  sources:(Array.isArray(t.sources)?t.sources:[]).map(cleanSource).filter(Boolean).slice(0,CHAT_LIMITS.sources),
  range:t.range&&Number.isFinite(t.range.start)&&Number.isFinite(t.range.count)?{start:Math.max(0,t.range.start),count:Math.max(8,t.range.count)}:null,
  windowTurnId:clipText(t.windowTurnId,100),asset:clipText(t.asset||'BTC',12),period:Object.hasOwn(CANDLE_PERIODS,t.period)?t.period:'1H',research:normalizeResearchConfig(t.research),reportId:clipText(t.reportId,100),reportOpen:t.reportOpen!==false,chartOpen:t.chartOpen!==false,
  turns:t.turns.filter(x=>x&&typeof x.question==='string').slice(-CHAT_LIMITS.turns).map(x=>({
   billingJob:clipText(x.billingJob,100),freeHelp:x.freeHelp===true,id:clipText(x.id,100),question:clipText(x.question,CHAT_LIMITS.questionLength),generatedQuestion:x.generatedQuestion===true,topic:['credits','risk','strategy','news','chain','returns','market'].includes(x.topic)?x.topic:null,mode:['ask','material','technical'].includes(x.mode)?x.mode:'ask',providerTask:providerTask(x.providerTask),
   sources:(Array.isArray(x.sources)?x.sources:[]).map(cleanSource).filter(Boolean).slice(0,CHAT_LIMITS.sources),
   ...(Number.isSafeInteger(x.answeredAt)&&x.answeredAt>0&&x.answeredAt<8_640_000_000_000_000-28_800_000?{answeredAt:x.answeredAt}:{}),
   ...(Array.isArray(x.quotes)?{quotes:x.quotes.slice(0,MAX_ASSISTANT_QUOTES).map(cleanAssistantQuote).filter(Boolean)}:{}),
   ...(x.mode==='ask'&&!x.billingJob&&x.localRecall===true?{localRecall:true}:{}),
   ...(x.mode==='ask'&&!x.billingJob&&x.needsMarketAsset===true?{needsMarketAsset:true}:{}),
   ...(x.mode==='ask'&&!x.billingJob&&x.modelReply?{modelReply:restoreModelReply(x.modelReply)}:{}),
   ...(x.mode==='ask'&&Array.isArray(x.evidence)?{evidence:cleanAnswerEvidence(x.evidence),evidenceReply:x.evidenceReply===true}:{}),
   technical:cleanTechnical(x.technical),marketContext:restoredMarketContext(x),report:normalizeResearchReport(x.report),followup:x.followup===true,
   context:x.context&&typeof x.context==='object'?{available:Number(x.context.available)||0,reserved:Number(x.context.reserved)||0,spent:Number(x.context.spent)||0,researchCost:Number(x.context.researchCost)||0}:null
  }))
 }));
 return {schema:1,threads,active:threads.some(t=>t.id===value.active)?value.active:(threads[0]?.id||'')};
}

export function assistantModelReceipt(receipt){
 if(receipt?.provider!=='openai'||typeof receipt.model!=='string'||
    !/^gpt-6\.2-sol(?:-\d{4}-\d{2}-\d{2})?$/.test(receipt.model))return null;
 return {provider:'openai',model:receipt.model,...(receipt.effort==='high'?{effort:'high'}:{})};
}

function restoreModelReply(reply){
 if(reply.state==='complete'&&typeof reply.text==='string'&&reply.text.trim()){
  const receipt=assistantModelReceipt(reply.receipt);
  return {state:'complete',text:clipText(reply.text,16000),...(reply.truncated===true?{truncated:true}:{}),...(receipt?{receipt}:{})};
 }
 const code=reply.state==='pending'?'INTERRUPTED':reply.code;
 return {state:'error',code:['INTERRUPTED','UNCONFIGURED','MODEL_TIMEOUT','RATE_LIMITED','REQUEST_INVALID'].includes(code)?code:'MODEL_UNAVAILABLE'};
}

export function cleanAnswerEvidence(items){
 return items.slice(0,8).flatMap(item=>{
  if(typeof item?.title!=='string'||typeof item?.text!=='string'||!item.text.trim())return [];
  const href=cleanSource({text:item.text,href:item.href})?.href||'';
  let sourceUrl='';
  try{const url=new URL(item.sourceUrl);if(url.protocol==='https:'&&!url.username&&!url.password)sourceUrl=url.href;}catch{}
  return [{title:clipText(item.title,140),text:clipText(item.text,2400),href,sourceUrl,
   kind:clipText(item.kind,24),symbol:clipText(item.symbol||item.asset,24),turnId:clipText(item.turnId,100),
   status:['empty','unavailable'].includes(item.status)?item.status:'observed',
   asOf:Number.isSafeInteger(item.asOf)&&item.asOf>0&&item.asOf<8.64e15?item.asOf:null}];
 });
}
