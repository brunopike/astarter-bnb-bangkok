import {isAssetOnlyReply,questionQuoteSymbols} from './assistant-analysis.mjs';
import {readAssistantQuotes} from './assistant-exchange-data.mjs';
import {readLiveSignalObservation} from './live-market-signals.mjs';
import {CROSS_MARKETS} from './cross-market-data.mjs';
import {createMarketHubClient, HUB_RESOURCES} from './market-hub-data.mjs';
import {newsBookmarkSnapshots} from './intelligence-news-feed.mjs';
import {currentPublicEnvelope, publicDataURL, validatePublicEnvelope} from './public-data-client.mjs';

const newsIntent = /新闻|快讯|头条|律动|舆情|消息|\b(news|headlines?|blockbeats|coindesk)\b/i;
const signalIntent = /信号|智选|动量|趋势|走势|看涨|看跌|偏[多空]|分析|行情|表现|强弱|\b(signals?|momentum|trend|bullish|bearish|analy[sz]e|analysis|performing|RSI|EMA\d*)\b/i;
const quoteIntent = /报价|价格|现价|市价|多少钱|涨跌幅|\b(quote|price|how much|trading at|24h change)\b/i;
const decisionPattern = /抄底|追[涨高]|逢低(?:买入|买进|买)|逢高卖出|入场时机|出场时机|(?:适合|值得|要不要|能不能|可不可以|可以|该不该|应该|能|该|值得现在)(?:现在)?(?:买入|卖出|入场|进场|加仓|减仓|买|卖)|\b(?:buy(?:ing)? the dip|catch(?:ing)? (?:the|a) bottom|(?:should|can) (?:i|we) (?:buy|sell|enter|exit)|(?:good|right) time to (?:buy|sell|enter|exit))\b/i;
export const asksMarketDecision = question => decisionPattern.test(question);
const continuation = /^(?:为什么(?:呢|这样|这么说)?|为何|依据是什么|怎么判断的|继续(?:说)?|还有呢|接着说|那[呢？?]?|why(?: is that| do you say that)?|what explains (?:that|it)|elaborate|continue)[。！？?.\s]*$/i;
const followUp = /^(?:那|它|这个|这条|继续|为什么|为何|怎么看|怎么判断|依据|根据|理由|还有呢|上涨|下跌|为什么)|\b(what about|how about|why|what explains|go on|its|that signal|elaborate)\b/i;
// A current tick or the latest closed candle cannot answer a dated question or a forecast.
export const asksOtherMarketTime = question => /历史|歷史|样例|示例|昨[天日晚夜晨]|前天|上个?[周週月季]|去年|明[天日早晚年]|后天|下个?[周週月季]|未来|未來|预测|預測|预估|目标价|会涨到|会跌到|\b(?:yesterday|tomorrow|historical|sample|example|forecast\w*|predict\w*|price target|last (?:night|week|month|year)|next (?:week|month|year)|will .{0,24}(?:price|cost|reach|rise|fall))\b|20\d\d[-年/]\d/i.test(question);
const privateOrOther = /钱包|我的账户|我的持仓|积分|下单|币安密钥|合约|永续|期货|盘口|资金费率|清算|\b(wallet|my account|my portfolio|credits?|place an order|futures?|perpetual|order ?book|funding rate|liquidations?)\b/i;
const educational = /^(?:什么是|怎[么樣样]理解|如何理解|解释一下|what (?:is|are)|explain how|define)\s*(?:(?:BTC|ETH|SOL)\s+)?(?:RSI|EMA\d*|动量|趋势|信号|momentum|trend|signal)\s*(?:[？?.!。]|$)/i;
const genericSignal = /^(?:(?:目前|现在|给我|今天|最新|有什么|有|哪些|看看|查看|全市场|市场|当前|智选|实时|帮我|一下|和|的|值得关注的|最近|推荐|平台|产品|信号|行情|[?？。!\s])+)$|\b(?:market overview|market signals?|latest signals?|current signals?|any signals?|what signals?|which signals?|trending signals?)\b/i;
const dataTopic = /ETF|净申赎|充值|提币|充提|流入|流出|净流量|资金流|清算|爆仓|强平|社媒|社交媒体|推特|\b(?:KOLs?|Twitter|LunarCrush|social|liquidations?|inflows?|outflows?|deposits?|withdrawals?|flows?)\b/i;
const dataFollowUp = /^(?:那|那么|换成|还有|其中|其[他它]|继续|看看|只看)|\b(?:what about|how about|and what|just show|instead|other exchanges?|other funds?)\b/i;
const baseline = ['BTC','ETH','SOL'];
// Only inherit an unnamed instrument if the entire question is a reference.
// A named instrument outside our universe must never resolve to the previous one.
const isReferenceQuestion = q => !q.replace(/为什么|为何|那|它|这(?:个|条)|该|对应|相關|相关|的|呢|吗|有|没|什么|哪些|最新|最近|现在|当前|今天|新闻|快讯|价格|现价|报价|信号|行情|趋势|走势|表现|依据|来自|哪里|原因|怎么|怎样|如何|判断|解释|是|\b(?:what|how|why|about|and|does|do|is|are|the|its?|this|that|current|latest|now|today|news|headlines?|price|quote|signals?|trend|momentum|evidence|means?|show|doing|come|from)\b|[?？。.！\s]/gi,'');
function isGeneralNews(question) {
  // Asking for article citations changes the format, not the market being covered.
  const topic = question.replaceAll('’', "'").replace(/总结|汇总|整理|逐条|列出|附上|标注|注明|来源|出处|发布时间|原文链接|\b(?:summari[sz]e|list|include|including|with|their|sources?|publication|times?|original links?)\b/gi, '');
  return !topic.replace(/请|帮我|给我|看|查|一下|最新|最近|今天|当前|市场|币圈|新闻|快讯|头条|消息|舆情|律动|有哪些|有什么|有|哪些|的|呢|吗|和|及|\b(?:what|are|is|the|any|latest|today(?:'s)?|current|recent|crypto|market|news|headlines?|show|me|please|do|you|have|for|and)\b|[，,、？?。.！!\s]/gi,'');
}
const newsHref = '?page=intelligence&data=live';
const latestNews = new WeakMap();
const format = n => new Intl.NumberFormat('en-US',{maximumFractionDigits:Math.abs(n)<1?6:2}).format(n);

function intents(text) {
  const decision = asksMarketDecision(text);
  return {news:newsIntent.test(text), signals:signalIntent.test(text)||decision, quotes:quoteIntent.test(text)||decision};
}
function isUnnamedDecision(text) {
  return asksMarketDecision(text) && isReferenceQuestion(text.replace(decisionPattern,'').replace(/那么|目前|请问|请|我们|我|能否|能不能|可不可以|可以|应该|能|该|[了不嘛么吧啊呀]|\b(?:it|now|then|the dip|please)\b/gi,''));
}

// Only a standalone spot-price question can inherit an instrument. Fees,
// derivatives, dated questions and explicitly named unknown assets stay separate.
function asksForReferencedQuote(question) {
  const text = question.trim().replace(/[？?！!.。]+$/, '').trim();
  return /^(?:那么?|请问|再查一下|再看一下|它|这个|这币|现在|当前|最新|实时|的)*(?:现价|价格|报价|多少钱|现在多少)(?:是|为)?(?:多少)?[钱呢呀啊了]*$/u.test(text) ||
    /^(?:(?:and |so )?(?:what(?:'s| is)|how much is) (?:its (?:current |latest |spot )?price|the (?:current |latest |spot )?(?:price|quote)|it(?: trading (?:at|for))?)(?: (?:now|today|right now))?|(?:its |the )?(?:current |latest |spot )?(?:price|quote)(?: now)?)$/i.test(text);
}

function previousQuoteSymbols(turns) {
  for (const turn of turns.slice(-5).reverse()) {
    const q = turn?.question;
    if (typeof q !== 'string' || turn.sources?.length || turn.providerTask ||
        (turn.mode && turn.mode !== 'ask') || asksOtherMarketTime(q) || privateOrOther.test(q)) return null;
    const quotes = turn.quotes?.map(row=>row.symbol).filter(Boolean);
    if (quotes?.length) return [...new Set(quotes)];
    if (quoteIntent.test(q) || signalIntent.test(q) || asksMarketDecision(q) || isAssetOnlyReply(q)) {
      const named = questionQuoteSymbols(q);
      if (named.length) return named;
    }
    if (!asksForReferencedQuote(q) && !continuation.test(q) && !isUnnamedDecision(q)) return null;
  }
  return [];
}

export function assistantDecisionContext(question, previousTurns = []) {
  const previous=previousTurns.at(-1);
  const text=previous?.needsMarketAsset && isAssetOnlyReply(question) ? question+'：'+previous.question : question;
  if (previous?.needsMarketAsset && isAssetOnlyReply(question) && asksForReferencedQuote(previous.question)) {
    return {question:text,needsAsset:false,quoteSymbols:questionQuoteSymbols(question)};
  }
  if (asksForReferencedQuote(question)) {
    const symbols = previousQuoteSymbols(previousTurns);
    if (symbols === null) return {question:text,needsAsset:false};
    return symbols.length === 1 ? {question:text,needsAsset:false,quoteSymbols:symbols} : {question:text,needsAsset:true};
  }
  const plan=isUnnamedDecision(text)?requestPlan(text,previousTurns.map(turn=>turn.question)):null;
  return {question:text,needsAsset:!!plan&&!plan.symbols.length};
}
function requestPlan(question, previous) {
  const q = String(question || '').trim(), flags = intents(q);
  if (!q || asksOtherMarketTime(q) || privateOrOther.test(q) || educational.test(q)) return null;
  let symbols = questionQuoteSymbols(q);
  // Never substitute a different quote currency, market or asset from an older turn.
  if (!symbols.length && /\b[A-Z0-9]{2,12}\s*[/\-]\s*[A-Z]{2,6}\b|\b[A-Z0-9]{2,12}(?:USDT|USDC)\b/i.test(q)) return null;
  const asksMarket = flags.news || flags.signals || flags.quotes;
  if (!asksMarket && !(followUp.test(q) && (symbols.length || continuation.test(q) || /信号|趋势|行情|它|这条|that signal|its price/.test(q))) && !(symbols.length && /怎么样|如何|怎么看|\bhow (?:is|are)|what about|how about/i.test(q))) return null;
  let prior;
  for (const text of previous.slice(-5).reverse()) {
    if (typeof text!=='string' || asksOtherMarketTime(text) || privateOrOther.test(text)) break;
    if (questionQuoteSymbols(text).length) {prior=text;break;}
    if (!continuation.test(text) && !isReferenceQuestion(text) && !isUnnamedDecision(text)) break;
  }
  const decisionFollowUp = isUnnamedDecision(q);
  if (!symbols.length && prior && (continuation.test(q) || decisionFollowUp || followUp.test(q) && isReferenceQuestion(q))) symbols=questionQuoteSymbols(prior);
  if (!asksMarket) {
    if (!symbols.length) return null;
    const old = prior ? intents(prior) : {};
    if (old.news) flags.news=true;
    else if (old.quotes && !old.signals) flags.quotes=true;
    else flags.signals=true;
  }
  if (!symbols.length && (flags.signals || flags.quotes) && genericSignal.test(q) && !/\b[A-Z]{2,10}\b/.test(q)) symbols=baseline;
  return {...flags,unknownNews:flags.news&&!symbols.length&&!isGeneralNews(q),symbols:symbols.slice(0,5)};
}

function unavailable(kind,title,href,zh,symbol='') {
  return {kind,status:'unavailable',title,href,text:zh?'当前没有可核验的公开数据。':'No verified public reading is available.',...(symbol?{symbol}:{})};
}
async function signalFact(symbol, io, zh) {
  const href='?page=signals&data=live&asset='+encodeURIComponent(symbol);
  const title=symbol+' · '+(zh?'智选信号':'Smart signals');
  try {
    const row=await readLiveSignalObservation(symbol,io);
    const labels=zh?{up:'上行动量',down:'下行动量',neutral:'中性观察'}:{up:'Upward momentum',down:'Downward momentum',neutral:'Neutral observation'};
    const facts=[labels[row.direction],row.market,(zh?'单根 K 线周期 ':'Candle interval ')+row.period,(zh?'收盘 ':'Close ')+format(row.price)+' '+row.unit,
      (zh?'动量（回看 5 根同周期 K 线） ':'Momentum (lookback: 5 candles at this interval) ')+format(row.momentumPct)+'%','EMA20 '+format(row.ema20),'RSI14 '+format(row.rsi14),row.source];
    return {kind:'signal',status:'observed',symbol,title,text:facts.join(' · '),href,asOf:row.closedAt};
  } catch {return unavailable('signal',title,href,zh,symbol);}
}

async function quoteFacts(symbols, io, zh) {
  if (!symbols.length) return [];
  // read() validates the market page/footer's cached public ticker without starting polling or a socket.
  const hub=createMarketHubClient({...io,resources:['tickers'],WebSocketImpl:null});
  const ticker=hub.read('tickers'),at=io.now(), bySymbol=new Map();
  for(const row of ticker.snapshot?.data || []){
    if(ticker.quality==='fresh' && row.asOf<=at && at-row.asOf<=HUB_RESOURCES.tickers.stale && row.pair===row.symbol+'USDT') {
      bySymbol.set(row.symbol,{symbol:row.symbol,state:'observed',source:'Binance Spot',market:row.symbol+'/USDT',price:row.price,change:row.change,unit:'USDT',asOf:row.asOf});
    }
  }
  const missing=symbols.filter(symbol=>!bySymbol.has(symbol));
  if(missing.length)for(const row of await readAssistantQuotes(missing,io))bySymbol.set(row.symbol,row);
  return symbols.map(symbol=>{
    const row=bySymbol.get(symbol), href='?page=markets&asset='+encodeURIComponent(symbol),title=symbol+' · '+(zh?'公开报价':'Public quote');
    if(row?.state!=='observed')return unavailable('quote',title,href,zh,symbol);
    const label=Object.hasOwn(CROSS_MARKETS,symbol)&&symbol!=='XAU'?(zh?'日线收盘 ':'Daily close '):'';
    return {kind:'quote',status:'observed',symbol,title,href,asOf:row.asOf,text:label+row.market+' '+format(row.price)+' '+row.unit+(row.change==null?'':' · 24h '+format(row.change)+'%')+' · '+row.source};
  });
}

async function newsFacts(symbols,io,zh) {
  const title=zh?'新闻舆情':'News & sentiment', query={limit:20},at=io.now();
  const {fetchImpl}=io;
  try {
    let cached=latestNews.get(fetchImpl);
    if(!cached||cached.received>at||at-cached.received>=60000){
      const response=await fetchImpl(publicDataURL('news',query),{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',signal:io.signal});
      if(!response.ok)throw Error();
      const body=validatePublicEnvelope(await response.json(),'news',query);
      if(body.mode!=='live_readonly'||body.coverage.scope!=='NEWS_FEED'||body.quality==='unavailable')throw Error();
      cached={body,received:at};latestNews.set(fetchImpl,cached);
    }
    const batch=currentPublicEnvelope(cached.body,at);
    if(batch.quality==='stale'||batch.quality==='unavailable'||batch.requested_at_ms>at+5000)throw Error();
    const healthy=new Set(batch.sources.filter(source=>source.status==='OK').map(source=>source.provider_id));
    const rows=batch.items.filter(row=>row.quality==='fresh'&&healthy.has(row.provider_id)&&row.data.published_at_ms<=at && row.valid_until_ms>at);
    const safe=newsBookmarkSnapshots(rows,rows.map(row=>row.record_id));
    const selected=safe.filter(row=>!symbols.length||symbols.some(symbol=>row.data.symbols.includes(symbol)||questionQuoteSymbols(row.data.title).includes(symbol)));
    if(!selected.length)return [{kind:'news',status:'empty',title,href:newsHref,text:zh?'当前可用快讯没有匹配报道。':'No matching headline in the current feed.'}];
    return selected.sort((a,b)=>b.data.published_at_ms-a.data.published_at_ms).slice(0,3).map(row=>({
      kind:'news',status:'observed',title:row.provider_id==='blockbeats-news-v1'?'BlockBeats':'CoinDesk',
      text:row.data.title,href:newsHref,sourceUrl:row.data.url,asOf:row.data.published_at_ms
    }));
  } catch {return [unavailable('news',title,newsHref,zh)];}
}

export async function readAssistantMarketContext({question,previousQuestions=[],locale='zh',fetchImpl=globalThis.fetch,now=Date.now,storageImpl,signal=AbortSignal.timeout(6000)}={}) {
  if (typeof question!=='string' || asksOtherMarketTime(question)) return [];
  const prior=Array.isArray(previousQuestions)?previousQuestions.filter(q=>typeof q==='string').slice(-5):[];
  const io={fetchImpl,now,storageImpl,signal}, zh=String(locale).startsWith('zh');
  async function readTopic(text) {
    const marketTopic=newsIntent.test(text)||quoteIntent.test(text)||signalIntent.test(text);
    if(dataTopic.test(text) || !marketTopic && dataFollowUp.test(text) && dataTopic.test(prior.at(-1)||'')) {
      return [unavailable('data',zh?'数据中心':'Data center','?page=markets',zh)];
    }
    const plan=requestPlan(text,prior);
    if(!plan || !plan.symbols.length && isUnnamedDecision(text))return [];
    const tasks=[];
    if(plan.signals) {
      if (!plan.symbols.length) tasks.push(unavailable('signal',zh?'智选信号':'Smart signals','?page=signals&data=live',zh));
      else for(const symbol of plan.symbols) tasks.push(signalFact(symbol,io,zh));
    }
    if(plan.quotes)tasks.push(quoteFacts(plan.symbols,io,zh));
    if(plan.news)tasks.push(plan.unknownNews?unavailable('news',zh?'新闻舆情':'News & sentiment',newsHref,zh):newsFacts(plan.symbols,io,zh));
    return (await Promise.all(tasks)).flat();
  }
  // "BTC and ETH ETFs" is one topic. "BTC ETFs and ETH news" has two topics
  // with different assets. A follow-up such as "and the news" inherits the previous asset.
  const parts=question.split(/\s*(?:以及|还有|另外|同时|和|与|及|[，,；;]|\band\b|\bplus\b)\s*/i).filter(Boolean);
  const hasTopic=text=>dataTopic.test(text)||newsIntent.test(text)||quoteIntent.test(text)||signalIntent.test(text);
  if(parts.length<2 || parts.length>4 || !parts.every(hasTopic))return readTopic(question);
  if(!parts.some(text=>dataTopic.test(text))&&!parts.every(text=>questionQuoteSymbols(text).length))return readTopic(question);
  const subjects=[];
  const topics=parts.map(text=>{
    const symbols=questionQuoteSymbols(text);
    if(symbols.length)subjects.splice(0,subjects.length,...symbols);
    else if(subjects.length && (isReferenceQuestion(text)||isGeneralNews(text)))return subjects.join(' ')+' '+text;
    return text;
  });
  const results=await Promise.all(topics.map(readTopic));
  // Preserve at least the leading result of each topic under the UI's 8-source cap.
  return Array.from({length:Math.max(...results.map(rows=>rows.length))},(_,index)=>results.flatMap(rows=>rows[index]||[])).flat().slice(0,8);
}
