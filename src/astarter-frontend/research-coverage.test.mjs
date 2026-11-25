import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {MarketResearch} from './live-research.mjs';
import {ASSETS} from './product-data.mjs';
import {DIMENSIONS} from './multi-research.mjs';
import {RESEARCH_BACKGROUND_RESOURCES,HUB_RESOURCES,normalizeHubResource,normalizeResearchBackground,validateResearchBackground} from './market-hub-data.mjs';
import {normalizeSpotDepth,validateSpotDepthSnapshot,SPOT_DEPTH_CLOCK_SKEW_MS} from './spot-depth-data.mjs';
import {candleRequest,normalizeKlines,mergeCandle} from './trading-chart-data.mjs';
import {CROSS_MARKETS,decodeDukascopy,normalizeCrossMarket,validateCrossSnapshot} from './cross-market-data.mjs';
import {marketScatterSample} from './workbench-market-analysis.mjs';
import {createLicensedFeeds} from './licensed-feeds.mjs';
import {parseBlockBeats} from './public-blockbeats.mjs';
import {fetchLunarCrush} from './public-lunarcrush.mjs';
import {parsePublicNews} from './public-news.mjs';
import {PUBLIC_ASSETS,publicQuery,publicDataURL,currentPublicEnvelope} from './public-data-client.mjs';
import {pair,initLocale,getLocale} from './locale.mjs';

// The accompanying baseline records the research model and the published source changes it covers.
// Synthetic inputs only, through the code's own parsers, normalizers, validators, served handler and ingest functions. No network read.
const coverage=JSON.parse(await readFile(new URL('./test-fixtures/research-coverage-v1.json',import.meta.url)));
const day=86400,NOW=Date.UTC(2026,10,18,0,1,40)/1000,TODAY=Math.floor(NOW/day)*day,NOW_MS=NOW*1000;
const {cells,sources}=coverage,daily=sources['daily-bars'],depth=sources['spot-depth'],pub=sources['public-context'],feeds=pub.feeds;
const SYMBOLS=coverage.assets.map(([symbol])=>symbol),domain=new Map(coverage.assets),KEYS=coverage.dimensions;
const background=Object.entries(sources).filter(([,source])=>source.resource);
// Recorded texts are compared with their Chinese half by name. Tests 1 to 3 and 6 build the model inside inLocale('zh'), so they check that half with or without the test-locale.mjs loader; test 5 checks the English half the same way.
const kept=status=>['retain','context'].includes(status),shown=([zh,en])=>pair(zh,en,'zh');
const TIME_KEYS=['asOf','closedAt','expires','receivedAt','requestStartedAt','sampleAt','validUntil'];
const fill=(pattern,values)=>pattern.replace(/<(\w+)>/g,(_,key)=>{assert.ok(Object.hasOwn(values,key),'no value for '+key);return String(values[key]);});
const model=()=>new MarketResearch({now:()=>NOW});
const item=(r,symbol,key)=>r.task(symbol).evidence.find(row=>row.key===key);
const statuses=r=>Object.fromEntries(SYMBOLS.map(symbol=>[symbol,Object.fromEntries(r.task(symbol).evidence.map(row=>[row.key,row.status]))]));
// What the list expects in a situation: status, source and provider per cell, after a failure when one is given.
// Without the news and social answers, a cell whose source is public-context reads missing and every other cell is unchanged.
function expected(situation,failure=null){
 const out=Object.fromEntries(SYMBOLS.map(symbol=>[symbol,Object.fromEntries(KEYS.map(key=>{
  const cell=cells[symbol][key],status=situation==='without_public_answers'?(cell.source==='public-context'?'missing':cell.all_connected_answer):cell[situation];
  return [key,{status,source:kept(status)?cell.source:null,provider:kept(status)?cell.provider:null}];
 }))]));
 for(const [symbol,key,after] of failure?.cells||[])out[symbol][key]=after;
 return out;
}
const statusOf=list=>Object.fromEntries(Object.entries(list).map(([symbol,row])=>[symbol,Object.fromEntries(Object.entries(row).map(([key,cell])=>[key,cell.status]))]));
const listed=(situation,failure)=>statusOf(expected(situation,failure));
const tally=values=>{const counts={retain:0,context:0,missing:0,na:0};for(const value of values)counts[value]++;return counts;};
const counted=r=>tally(SYMBOLS.flatMap(symbol=>r.task(symbol).evidence.map(row=>row.status)));
const listedCount=situation=>tally(Object.values(listed(situation)).flatMap(Object.values));

// Daily rows carry the scanner projection shape; depth and context go through their own normalizers.
const dailyRequest=symbol=>candleRequest(domain.get(symbol)==='Crypto'?{market:symbol+'/USDT',period:'1D'}:{market:symbol,period:'1D',profileId:'public-market',venueId:daily.per_asset[symbol].venue});
function dailyRow(symbol,patch={}){
 const {provider,timezone,unit,venue}=daily.per_asset[symbol],valid=daily.evidence_valid_until[venue].seconds_after_sample,sampleAt=domain.get(symbol)==='Crypto'?TODAY-day:TODAY-23*3600;
 return {symbol,source:provider,timezone,unit,state:'ready',feedState:'snapshot',paused:false,period:daily.period,methodVersion:daily.method_version,price:100,x:0,y:50,change:0,bars:300,signal:'balanced',sampleAt,closedAt:TODAY,validUntil:valid===null?TODAY+3*day:sampleAt+valid,...patch};
}
const side=(n,start,step,quantity)=>Array.from({length:n},(_,i)=>[(start+i*step).toFixed(1),quantity]);
const book=(symbol,levels=100,times={requestStartedAt:NOW_MS-500,receivedAt:NOW_MS-100})=>normalizeSpotDepth({lastUpdateId:10,bids:side(levels,99.9,-.1,'2'),asks:side(levels,100.1,.1,'3')},symbol,times);
const depthSnapshot=symbol=>{try{return book(symbol);}catch{return null;}};
const bodies={sentiment:{data:[{timestamp:String(TODAY-day),value:'40'},{timestamp:String(TODAY),value:'37'}]},stablecoins:[{date:TODAY-day,totalCirculatingUSD:{peggedUSD:90}},{date:TODAY,totalCirculatingUSD:{peggedUSD:100,peggedEUR:20}}],chains:[{name:'Ethereum',tvl:1000},{name:'Solana',tvl:500},{name:'Other chain',tvl:2000}]};
const latest={sentiment:37,stablecoins:120};
const contextSnapshot=resource=>normalizeResearchBackground({schema:'public-market-relay-v1',resource,receivedAt:NOW_MS,body:bodies[resource]},resource,NOW_MS);

// News and social come from the served handler (licensed-feeds.mjs) with its three readers replaced by fixed rows.
// Headlines go through the dev's own BlockBeats and CoinDesk parsers; one headline names each asset.
const TITLES={BTC:'Bitcoin headline',ETH:'Ether headline',SOL:'Solana headline',SPX:'SPX headline',NDX:'Nasdaq 100 headline',XAU:'Gold headline',DXY:'Dollar index headline',US10Y:'10-year Treasury headline'};
const beijing=at=>new Date(at+8*3600000).toISOString().slice(0,19).replace('T',' ');
const flash=(symbols,first=101)=>({status:0,data:{data:symbols.map((symbol,i)=>({id:first+i,title:TITLES[symbol],link:'https://m.theblockbeats.info/flash/'+(first+i),create_time:beijing(NOW_MS-60000-i*60000)}))}});
const rss=symbols=>'<rss><channel><title>CoinDesk</title>'+symbols.map((symbol,i)=>`<item><title>${TITLES[symbol]}</title><link>https://www.coindesk.com/markets/2026/11/18/c${i+1}</link><pubDate>${new Date(NOW_MS-60000-i*60000).toUTCString()}</pubDate></item>`).join('')+'</channel></rss>';
const curation={minFollowers:50000,maxTopicRank:100,minCreatorInteractions24h:1000,minDistinctPosts:2,maxPostsPerAuthor:1,checkedTopics:['BTC','ETH','SOL'],failedTopics:[],rankedCreators:9,qualifiedCreators:1};
const topicRow=(symbol,topic,asOf)=>({symbol,topic,asOf,posts24h:120,contributors24h:40,interactions24h:5000,sentimentByNetwork:{X:61}});
const lunar={provider:'LunarCrush',observedAt:NOW_MS,errors:[],curation,topics:[topicRow('BTC','bitcoin',NOW_MS-600000),topicRow('ETH','ethereum',null),topicRow('SOL','solana',null)],
 posts:[{network:'X',id:'7',title:'Solana staking volume post',url:'https://x.com/example/status/7',author:'example',symbols:['SOL'],publishedAt:NOW_MS-86400000+1800000,interactions24h:50,creatorId:'twitter::7',followers:56000,profileUrl:null,topicRank:14,creatorInteractions24h:1300,qualifyingPostCount:2,evidenceSymbol:'SOL'}]};
function offlineFeeds(options){
 const unexpected=[];
 const unconfigured=name=>async()=>{unexpected.push(name);throw Error('OFFLINE_FIXTURE');};
 const handle=createLicensedFeeds({bluesky:unconfigured('Bluesky'),nostr:unconfigured('Nostr'),...options});
 return async(req,res)=>{await handle(req,res);assert.deepEqual(unexpected,[],'unconfigured direct social reader');};
}
async function served(resource,readers,{env={},fetchImpl=async()=>assert.fail('no network read'),feed}={}){
 const handle=offlineFeeds({now:()=>NOW_MS,env,fetchImpl,...readers});let status=null,body=null;
 await handle({url:publicDataURL(resource,{limit:feeds[resource].requested.page_limit,feed}),method:'GET'},{writeHead(code){status=code;},end(text){body=JSON.parse(text);}});
 return {status,body};
}
const newsReaders={blockbeats:async()=>parseBlockBeats(flash(SYMBOLS),NOW_MS),coindesk:async()=>parsePublicNews(rss(SYMBOLS),NOW_MS).items};
const answers={news:(await served('news',newsReaders)).body,social:(await served('social',{lunarcrush:async()=>structuredClone(lunar)})).body};

function answered({dailyError=null,depthError=null,contextError=null,bars,publicError=null,failedAs='null',public:withPublic=true}={}){
 const r=model();
 r.ingestMarket(SYMBOLS.map(symbol=>{
  const {provider,timezone,unit}=daily.per_asset[symbol],snapshot=symbol===depthError?null:depthSnapshot(symbol);
  const row=symbol===dailyError?{symbol,source:provider,timezone,unit,feedState:'error',state:'error',paused:false}:dailyRow(symbol,bars===undefined?{}:{bars});
  return {...row,depthState:symbol===depthError?'error':snapshot?'ready':'unsupported',depthSnapshot:snapshot};
 }));
 r.ingest(RESEARCH_BACKGROUND_RESOURCES.map(resource=>resource===contextError?{resource,state:'error',snapshot:null}:{resource,state:'ready',snapshot:contextSnapshot(resource)}));
 // The page passes null when a read failed with no earlier answer, or the kept answer marked stale by the client.
 if(withPublic)for(const resource of Object.keys(feeds))r.ingestPublic(resource,resource!==publicError?answers[resource]:failedAs==='stale'?currentPublicEnvelope(answers[resource],NOW_MS,true):null);
 return r;
}
const lost=(symbol,key)=>[symbol,key,{status:'missing',source:null,provider:null}];
const failures=[
 ...SYMBOLS.map(symbol=>({name:`the daily source of ${symbol} fails`,options:{dailyError:symbol},source:'daily-bars',symbol,
  trace:{...daily.failure_trace,text:daily.failure_trace.text.map(template=>fill(template,daily.per_asset[symbol]))},cells:[lost(symbol,daily.dimension)]})),
 ...depth.assets.map(symbol=>({name:`the depth source of ${symbol} fails`,options:{depthError:symbol},source:'spot-depth',symbol,trace:depth.failure_trace,cells:[lost(symbol,depth.dimension)]})),
 ...background.flatMap(([id,source])=>[false,true].map(withPublic=>({name:`the ${source.resource} source fails, ${withPublic?'with':'without'} the news and social answers`,options:{contextError:source.resource,public:withPublic},source:id,trace:source.failure_trace,
  cells:source.assets.map(symbol=>{const after=withPublic&&source.failure_trace.with_public_answers?.[symbol]?.[source.dimension];return after?[symbol,source.dimension,after]:lost(symbol,source.dimension);})}))),
 ...Object.entries(feeds).flatMap(([resource,feed])=>['null','stale'].map(failedAs=>({name:`the ${resource} read fails (${failedAs})`,options:{publicError:resource,failedAs},source:'public-context',trace:feed.failure_trace,
  cells:Object.entries(feed.failure_trace.cells_after).map(([symbol,after])=>[symbol,pub.dimension,after])})))
];
const situationOf=failure=>failure.options.public===false?'without_public_answers':'all_connected_answer';
function traceState(r,failure){
 const [holder,field]=failure.trace.state_field.split('.');
 if(holder==='shared')return r.shared.find(row=>row.id===sources[failure.source].dimension)[field];
 if(holder==='publicFeeds')return r.publicFeeds[field];
 return r.task(failure.symbol)[holder][field];
}
function sourceTimes(r,id,symbol){
 if(id==='daily-bars'){const row=dailyRow(symbol);return {closedAt:row.closedAt,validUntil:row.validUntil,ids:{symbol,sampleAt:row.sampleAt,closedAt:row.closedAt,method_version:daily.method_version}};}
 if(id==='spot-depth'){const s=book(symbol);return {requestStartedAt:s.requestStartedAt,receivedAt:s.receivedAt,validUntil:s.validUntil,ids:{symbol,lastUpdateId:s.lastUpdateId,requestStartedAt:s.requestStartedAt,receivedAt:s.receivedAt,method_version:depth.method_version}};}
 if(id==='public-context')return {ids:{symbol,publicVersion:r.task(symbol).publicVersion}};
 const {resource}=sources[id],s=contextSnapshot(resource);
 return {asOf:s.asOf,receivedAt:s.receivedAt,validUntil:s.validUntil,ids:{resource,asOf:s.asOf,receivedAt:s.receivedAt,version:r.background[resource].version}};
}
// The served handler is asked with a fake fetch that records the provider address and refuses the body.
async function upstream(path){
 const calls=[],handle=offlineFeeds({now:()=>NOW_MS,env:{BLOCKBEATS_API_KEY:'fixture-key-not-a-token',LUNARCRUSH_API_KEY:'fixture-key-not-a-token'},fetchImpl:async(url,options)=>{calls.push({url:new URL(url),method:options?.method??'GET'});return {ok:true,status:200,headers:{get:()=>null},text:async()=>'{}'};}});
 await handle({url:path,method:'GET'},{writeHead(){},end(){}});return calls;
}
async function asked(requested,values){
 const calls=await upstream(fill(requested.relay_path,values)),parts=requested.windows||requested.requests||[{upstream_parameters:requested.upstream_parameters}];
 assert.equal(calls.length,parts.length,requested.relay_path);
 parts.forEach((part,i)=>{
  const {url,method}=calls[i];
  assert.equal(method,'GET',url.pathname);
  assert.deepEqual(Object.fromEntries(url.searchParams),Object.fromEntries(Object.entries(part.upstream_parameters).map(([key,value])=>[key,fill(value,values)])),fill(requested.relay_path,values));
  if(part.path)assert.equal(url.pathname,fill(part.path,values));
  if(part.path_ends_with)assert.ok(url.pathname.endsWith(fill(part.path_ends_with,values)),url.pathname);
  if(part.host)assert.equal(url.origin,'https://'+part.host,url.href);
 });
}
function yahooRaw(symbol,n){
 const spec=CROSS_MARKETS[symbol],last=TODAY-day+52200,quote=value=>Array(n).fill(value);
 return {chart:{error:null,result:[{meta:{symbol:spec.id,instrumentType:'INDEX',exchangeTimezoneName:spec.timezone,regularMarketTime:last+23400,currentTradingPeriod:{regular:{start:last,end:last+23400}}},timestamp:Array.from({length:n},(_,i)=>last-(n-1-i)*day),indicators:{quote:[{open:quote(100),high:quote(101),low:quote(99),close:quote(100),volume:quote(0)}]}}]}};
}
const gold=(n,start)=>({timestamp:start*1000,shift:day*1000,multiplier:.001,open:100,high:101,low:99,close:100,times:Array.from({length:n},(_,i)=>i?1:0),opens:Array(n).fill(0),highs:Array(n).fill(0),lows:Array(n).fill(0),closes:Array(n).fill(0)});
function snapshotLimit(body,request,most){
 const first=body.bars[0],earlier={...first,time:first.time-day,closedAt:first.time,validUntil:first.time+1800};
 assert.equal(validateCrossSnapshot(body,request,NOW_MS),body);
 assert.equal(validateCrossSnapshot({...body,bars:[earlier,...body.bars.slice(1)]},request,NOW_MS).bars.length,most);
 assert.throws(()=>validateCrossSnapshot({...body,bars:[earlier,...body.bars]},request,NOW_MS),/INVALID_MARKET_SNAPSHOT/);
}
// The locale is switched inside this process the way the dev's research-board.test.mjs L24-L34 does it: initLocale() on a minimal document, then set().
async function inLocale(next,check){
 const keys=['document','MutationObserver','NodeFilter'],previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),before=getLocale();
 const body={nodeType:1,closest:()=>null,querySelectorAll:()=>[]},document=Object.assign(new EventTarget(),{body,documentElement:{lang:'',dataset:{},style:{setProperty(){}}},createTreeWalker:()=>({nextNode:()=>null}),querySelector:()=>null,querySelectorAll:()=>[]});
 let locale=null;
 try{
  Object.defineProperty(globalThis,'document',{configurable:true,value:document});Object.defineProperty(globalThis,'MutationObserver',{configurable:true,value:class{observe(){}disconnect(){}}});Object.defineProperty(globalThis,'NodeFilter',{configurable:true,value:{SHOW_TEXT:4}});
  locale=initLocale();await locale.set(next);await check();
 }finally{
  if(locale)await locale.set(before);
  for(const key of keys){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
 }
}

test('before any source answers, the coverage list matches the research model for eight assets and six dimensions',()=>inLocale('zh',()=>{
 assert.deepEqual(ASSETS.map(([symbol,,kind])=>[symbol,kind]),coverage.assets);assert.deepEqual(DIMENSIONS.map(([key])=>key),KEYS);assert.equal(SYMBOLS.length*KEYS.length,48);
 const r=model();
 assert.equal(r.mode,coverage.code.mode,'mode of the research model');
 assert.deepEqual(statuses(r),listed('before_any_answer'));
 assert.deepEqual(counted(r),coverage.counts.before_any_answer);assert.deepEqual(listedCount('before_any_answer'),coverage.counts.before_any_answer);
 for(const symbol of SYMBOLS)for(const row of r.task(symbol).evidence){assert.equal(row.sourceId,null);assert.equal(row.source,shown(coverage.no_source_text),`${symbol} ${row.key}`);}
 assert.ok(r.shared.every(source=>source.decision==='missing'));
}));

test('with every connected source answering, coverage is daily bars for eight assets, depth for three, three kinds of background, public news and social context, and the listed history bounds',()=>inLocale('zh',async()=>{
 assert.deepEqual([...RESEARCH_BACKGROUND_RESOURCES].sort(),background.map(([,source])=>source.resource).sort());
 assert.deepEqual(SYMBOLS.filter(symbol=>depthSnapshot(symbol)),depth.assets,'the spot-depth normalizer decides the depth assets');
 for(const [id,source] of Object.entries(sources))assert.deepEqual(SYMBOLS.filter(symbol=>KEYS.some(key=>cells[symbol][key].source===id)),source.assets,id);
 const r=answered(),bare=answered({public:false}),used=new Map();
 assert.deepEqual(statuses(r),listed('all_connected_answer'));
 assert.deepEqual(counted(r),coverage.counts.all_connected_answer);assert.deepEqual(listedCount('all_connected_answer'),coverage.counts.all_connected_answer);
 // Without the news and social answers the list is the one recorded at main 49d6a03.
 assert.deepEqual(statuses(bare),listed('without_public_answers'));
 assert.deepEqual(counted(bare),coverage.counts.without_public_answers);assert.deepEqual(listedCount('without_public_answers'),coverage.counts.without_public_answers);
 for(const symbol of SYMBOLS)for(const key of KEYS){
  const cell=cells[symbol][key],row=item(r,symbol,key);
  if(!kept(cell.all_connected_answer)){assert.equal(cell.provider,null);assert.equal(row.source,shown(coverage.no_source_text),`${symbol} ${key}`);continue;}
  const source=sources[cell.source];assert.equal(source.dimension,key);assert.equal(source.kept_status,cell.all_connected_answer);
  assert.equal(cell.provider,source.per_asset?.[symbol].provider??source.provider,`${symbol} ${key}`);assert.equal(row.source,cell.provider,`${symbol} ${key}`);
  for(const name of source.per_asset?.[symbol].providers??[cell.provider])used.set(name,new Set([...(used.get(name)||[]),cell.source]));
  // The public summary is added only to the cells listed with text_adds; every other kept text is the same with and without the public answers.
  if(cell.source!=='public-context'){
   const plain=item(bare,symbol,key).text;
   if(cell.text_adds){const fallback=item(answered({contextError:sources[cell.source].resource}),symbol,key);assert.equal(fallback.sourceId.split(':')[0],cell.text_adds);assert.equal(row.text,plain+' / '+fallback.text,`${symbol} ${key}`);}
   else assert.equal(row.text,plain,`${symbol} ${key}`);
  }
 }
 assert.deepEqual(SYMBOLS.filter(symbol=>KEYS.some(key=>cells[symbol][key].text_adds==='public-context')),pub.text_added_to);
 assert.deepEqual(Object.keys(coverage.providers).sort(),[...used.keys()].sort());
 for(const [name,entry] of Object.entries(coverage.providers)){
  assert.deepEqual([...entry.used_by].sort(),[...used.get(name)].sort(),name);
  for(const field of coverage.unknown_fields.fields)assert.equal(entry[field],null,`${name}: the code holds no ${field}`);
 }
 for(const symbol of SYMBOLS){
  const spec=daily.per_asset[symbol],request=dailyRequest(symbol);assert.ok(request,symbol);assert.equal(request.venueId,spec.venue,symbol);
  if(request.sessionBased){assert.equal(request.source,spec.provider);assert.equal(request.timezone,spec.timezone);assert.equal(request.unit,spec.unit);}
 }
 // Accepted history length and validity of a daily row, per source.
 const {min,max}=daily.history.research_accepts_bars;
 for(const symbol of SYMBOLS){
  for(const [bars,status] of [[min-1,'missing'],[min,'retain'],[max,'retain'],[max+1,'missing']]){const probe=model();probe.ingestMarket([dailyRow(symbol,{bars})]);assert.equal(item(probe,symbol,daily.dimension).status,status,`${symbol} with ${bars} closed bars`);}
  const seconds=daily.evidence_valid_until[daily.per_asset[symbol].venue].seconds_after_sample,probe=model();
  probe.ingestMarket([dailyRow(symbol,{validUntil:dailyRow(symbol).validUntil+(seconds===null?7:1)})]);assert.equal(item(probe,symbol,daily.dimension).status,seconds===null?'retain':'missing',`${symbol} validity window`);
  // Daily times are Unix seconds: the same row with its times in milliseconds is refused.
  const plain=dailyRow(symbol);
  for(const [unit,factor] of [['s',1],['ms',1000]]){const unitProbe=model();unitProbe.ingestMarket([dailyRow(symbol,{sampleAt:plain.sampleAt*factor,closedAt:plain.closedAt*factor,validUntil:plain.validUntil*factor})]);assert.equal(item(unitProbe,symbol,daily.dimension).status,unit===daily.item.time_unit?'retain':'missing',`${symbol} with its times in ${unit}`);}
 }
 // Binance: validUntil is one day after closedAt, so the same row closing one second earlier or later reads missing.
 const afterClose=daily.evidence_valid_until.binance.seconds_after_close;
 for(const symbol of SYMBOLS.filter(symbol=>daily.per_asset[symbol].venue==='binance'))for(const shift of [0,-1,1]){const row=dailyRow(symbol),probe=model();probe.ingestMarket([{...row,closedAt:row.validUntil-afterClose+shift}]);assert.equal(item(probe,symbol,daily.dimension).status,shift?'missing':'retain',`${symbol}: validUntil ${afterClose-shift} s after closedAt`);}
 const minimum=daily.history.scanner_minimum_closed_bars;
 const closedBars=(n,session)=>Array.from({length:n},(_,i)=>{const time=TODAY-(n-i)*day;return session?{time,open:100,high:101,low:99,close:100,volume:null,closedAt:time+day,validUntil:time+4*day}:{time,open:100,high:101,low:99,close:100,volume:100};});
 for(const symbol of SYMBOLS){
  const request=dailyRequest(symbol),sample=marketScatterSample(closedBars(minimum.value,request.sessionBased),NOW,request);
  assert.equal(marketScatterSample(closedBars(minimum.value-1,request.sessionBased),NOW,request).state,minimum.state_below,symbol);assert.equal(sample.state,'ready',symbol);assert.equal(sample.bars,minimum.value);
 }
 // What each source asks the provider for, read from the served handler's own outbound request.
 const year=new Date(NOW_MS).getUTCFullYear(),dates={previous_year:year-1,current_hour_start_ms:Math.floor(NOW_MS/3600000)*3600000};
 for(const symbol of SYMBOLS)await asked(daily.history.per_venue[daily.per_asset[symbol].venue].requested,{SYMBOL:symbol,...dates});
 for(const symbol of depth.assets)await asked(depth.history.requested,{SYMBOL:symbol});
 for(const [,source] of background)await asked(source.history.requested,{resource:source.resource});
 // How much history each daily source accepts and keeps.
 const binance=daily.history.per_venue.binance,btc=dailyRequest('BTC'),keep=binance.kept_maximum_bars.value;
 const klines=n=>Array.from({length:n},(_,i)=>{const time=(TODAY-(n-i)*day)*1000;return [time,'100','101','99','100','10',time+day*1000-1];});
 assert.equal(normalizeKlines(klines(binance.response_maximum_rows.value),btc).length,binance.response_maximum_rows.value);assert.throws(()=>normalizeKlines(klines(binance.response_maximum_rows.value+1),btc),/INVALID_CANDLES/);
 const series=Array.from({length:keep},(_,i)=>({time:TODAY-(keep-i)*day,open:100,high:101,low:99,close:100,volume:10})),merged=mergeCandle(series,{...series.at(-1),time:TODAY},day);
 assert.equal(merged.length,keep);assert.equal(merged[0].time,series[1].time);
 const yahoo=daily.history.per_venue.yahoo;
 for(const symbol of SYMBOLS.filter(symbol=>daily.per_asset[symbol].venue==='yahoo')){
  const most=yahoo.response_maximum_timestamps.value,body=normalizeCrossMarket(yahooRaw(symbol,most),symbol,NOW_MS);
  assert.equal(body.bars.length,yahoo.kept_maximum_bars.value,symbol);assert.throws(()=>normalizeCrossMarket(yahooRaw(symbol,most+1),symbol,NOW_MS),/INVALID_INDEX_DATA/);
  snapshotLimit(body,dailyRequest(symbol),yahoo.kept_maximum_bars.value);
 }
 const dukascopy=daily.history.per_venue.dukascopy,days=dukascopy.response_maximum_days_per_window.value;
 assert.equal(decodeDukascopy(gold(days,TODAY-days*day)).length,days);assert.throws(()=>decodeDukascopy(gold(days+1,TODAY-days*day)),/INVALID_GOLD_DATA/);
 const later=dukascopy.kept_maximum_bars.value-days+70,start=TODAY-(days+later)*day,xau=normalizeCrossMarket([gold(days,start),gold(later,start+days*day)],'XAU',NOW_MS);
 assert.equal(xau.bars.length,dukascopy.kept_maximum_bars.value);snapshotLimit(xau,dailyRequest('XAU'),dukascopy.kept_maximum_bars.value);
 // Where the validUntil of a kept daily item comes from: provider bars through the code's normalizer, then the scanner, then the model.
 const providerBars={binance:symbol=>normalizeKlines(klines(300),dailyRequest(symbol)),yahoo:symbol=>normalizeCrossMarket(yahooRaw(symbol,300),symbol,NOW_MS).bars,dukascopy:symbol=>normalizeCrossMarket([gold(days,start),gold(later,start+days*day)],symbol,NOW_MS).bars};
 for(const symbol of SYMBOLS){
  const venue=daily.per_asset[symbol].venue,seconds=daily.evidence_valid_until[venue].seconds_after_sample,bars=providerBars[venue](symbol),sample=marketScatterSample(bars,NOW,dailyRequest(symbol)),probe=model();
  probe.ingestMarket([dailyRow(symbol,{sampleAt:sample.sampleAt,closedAt:sample.closedAt,validUntil:sample.validUntil,bars:sample.bars})]);const row=item(probe,symbol,daily.dimension);
  assert.equal(row.status,'retain',symbol);assert.equal(row.validUntil,seconds===null?bars.filter(bar=>bar.closedAt<=NOW).at(-1).validUntil:sample.sampleAt+seconds,`${symbol}: validUntil of the kept item`);
 }
 // Depth: one snapshot, bounded levels and receipt window.
 const levels=depth.history.levels_per_side,receipt=depth.receipt_window_maximum_ms.value,started=NOW_MS-receipt-1000;
 assert.equal(book('BTC',levels.max).bidLevels,levels.max);assert.throws(()=>book('BTC',levels.max+1),/INVALID_SPOT_DEPTH/);
 assert.equal(book('BTC',levels.min).askLevels,levels.min);assert.throws(()=>book('BTC',levels.min-1),/INVALID_SPOT_DEPTH/);
 const timed=book('BTC',100,{requestStartedAt:started,receivedAt:started+receipt});
 assert.equal(timed.validUntil-timed[depth.evidence_valid_for_ms.from],depth.evidence_valid_for_ms.value);assert.throws(()=>book('BTC',100,{requestStartedAt:started,receivedAt:started+receipt+1}),/INVALID_SPOT_DEPTH/);
 assert.equal(SPOT_DEPTH_CLOCK_SKEW_MS,depth.clock_skew_allowance_ms.value);
 // A snapshot received up to the clock skew allowance ahead of now passes the validator; one millisecond more is refused.
 const skew=depth.clock_skew_allowance_ms.value,ahead=ms=>book('BTC',100,{requestStartedAt:NOW_MS-500,receivedAt:NOW_MS+ms});
 assert.equal(validateSpotDepthSnapshot(ahead(skew),'BTC',NOW_MS).receivedAt,NOW_MS+skew);assert.throws(()=>validateSpotDepthSnapshot(ahead(skew+1),'BTC',NOW_MS),/INVALID_SPOT_DEPTH/,`a snapshot received ${skew+1} ms ahead of now`);
 // Context: response limits, what the research model keeps, and its validity window.
 const rows={sentiment:n=>({data:Array.from({length:n},(_,i)=>({timestamp:String(TODAY-(n-1-i)*day),value:'50'}))}),stablecoins:n=>Array.from({length:n},(_,i)=>({date:TODAY-(n-1-i)*day,totalCirculatingUSD:{peggedUSD:i+1}})),chains:n=>Array.from({length:n},(_,i)=>({name:'Chain '+i,tvl:i+1}))};
 for(const [id,source] of background){
  const {resource,history}=source,most=history.response_maximum_rows.value,snapshot=contextSnapshot(resource),keeps=history.research_keeps;
  assert.equal(normalizeHubResource(resource,rows[resource](most),NOW_MS).data.length,history.normalized_series_maximum_points?.value??most,id);assert.throws(()=>normalizeHubResource(resource,rows[resource](most+1),NOW_MS),/INVALID_DATA/,id);
  if(keeps.rows)assert.deepEqual(snapshot.data,keeps.rows.map(name=>bodies[resource].find(row=>row.name===name)),id);else assert.deepEqual(snapshot.data,{[keeps.field]:latest[resource]},id);
  assert.equal(HUB_RESOURCES[resource].provider,source.provider,id);assert.equal(HUB_RESOURCES[resource].stale,source.evidence_valid_for_ms.value,id);
  assert.equal(snapshot.validUntil-snapshot[source.evidence_valid_for_ms.from],source.evidence_valid_for_ms.value,id);
 }
 // Chains: the code's own answer passes the validator with its two rows, and a third row is refused. An answer with only one of the two rows is the open case under not_recorded and is not tested.
 const chains=contextSnapshot('chains'),mostRows=sources['background-chains'].history.research_keeps.most_rows;
 assert.equal(validateResearchBackground(chains,'chains',NOW_MS).data.length,mostRows);
 for(const extra of [chains.data[0],{name:'Other chain',tvl:2000}])assert.throws(()=>validateResearchBackground({...chains,data:[...chains.data,extra]},'chains',NOW_MS),/BACKGROUND_INVALID/,`a chains answer with ${mostRows+1} rows`);
}));

test('a provider failure and a part answer each leave their own trace, and every other cell keeps its full status',()=>inLocale('zh',()=>{
 for(const failure of failures){
  const r=answered(failure.options),trace=failure.trace;
  assert.deepEqual(statuses(r),listed(situationOf(failure),failure),failure.name);
  assert.deepEqual(traceState(r,failure),trace.state,failure.name);
  for(const [symbol,key,after] of failure.cells){
   const row=item(r,symbol,key),label=`${failure.name}: ${symbol} ${key}`;assert.equal(row.status,after.status,label);
   if(after.status==='missing'){assert.equal(trace.status,'missing',label);assert.equal(row.text,shown(trace.text),label);assert.equal(row.source,shown(coverage.no_source_text),label);assert.equal(row.sourceId,null,label);}
   else{assert.equal(row.source,after.provider,label);assert.equal(row.sourceId.split(':')[0],after.source,label);}
  }
  assert.deepEqual(r.shared.map(row=>row.decision),r.shared.map(row=>failure.options.contextError&&row.id===sources[failure.source].dimension?'missing':'context'),failure.name);
 }
}));

test('every kept item carries the time fields listed for its source, and no situation grants trading authority',()=>{
 const {min,max}=daily.history.research_accepts_bars;
 const situations=[['before any source answers',model(),'before_any_answer'],['every connected source answers',answered(),'all_connected_answer'],['every connected source but news and social answers',answered({public:false}),'without_public_answers'],[`daily rows with ${min} bars`,answered({bars:min}),'all_connected_answer'],[`daily rows with ${max} bars`,answered({bars:max}),'all_connected_answer'],...failures.map(failure=>[failure.name,answered(failure.options),situationOf(failure),failure])];
 for(const [name,r,situation,failure=null] of situations){
  const want=expected(situation,failure);let keptItems=0;
  for(const symbol of SYMBOLS){
   assert.equal(r.context(symbol).ready,false,name);assert.equal(r.handoff(symbol),null,name);assert.equal(r.task(symbol).outcome,'missing',name);
   for(const row of r.task(symbol).evidence){
    const label=`${name}: ${symbol} ${row.key}`;assert.equal(row.status,want[symbol][row.key].status,label);
    if(!kept(row.status)){assert.deepEqual(Object.keys(row).sort(),coverage.missing_item_keys,label);assert.equal(row.sourceId,null,label);continue;}
    keptItems++;
    const id=want[symbol][row.key].source,source=sources[id],spec=source.item,times=sourceTimes(r,id,symbol);
    assert.deepEqual(Object.keys(row).sort(),spec.keys,label);assert.equal(row.methodVersion,source.method_version,label);
    assert.equal(row.sharedVersion,source.resource?r.background[source.resource].version:null,`${label} sharedVersion`);
    assert.equal(row.timeBasis??null,spec.time_basis,label);assert.equal(Object.hasOwn(row,'timeUnit'),spec.time_unit_on_item,label);if(spec.time_unit_on_item)assert.equal(row.timeUnit,spec.time_unit,label);
    assert.deepEqual(Object.keys(row).filter(key=>TIME_KEYS.includes(key)).sort(),[...spec.time_fields].sort(),`${label} time fields`);
    for(const field of spec.time_fields)assert.equal(row[field],times[field],`${label} ${field}`);
    assert.equal(row.sourceId,fill(spec.source_id,times.ids),label);
    if(id==='daily-bars'){const asset=daily.per_asset[symbol];assert.equal(row.period,daily.period,label);assert.equal(row.timezone,asset.timezone,label);assert.equal(row.unit,asset.unit,label);}
    if(source.unit)assert.equal(row.unit,source.unit,label);
    if(spec.time_in_text){const iso=new Date(times[spec.time_in_text.field]).toISOString();assert.ok(row.text.includes(spec.time_in_text.format==='utc-date'?iso.slice(0,10):iso),label);}
   }
  }
  assert.equal(keptItems,Object.values(statusOf(want)).flatMap(Object.values).filter(kept).length,`${name}: kept items`);
  assert.equal(r.summary().candidates,0,name);assert.equal(r.process().ready,false,name);
 }
});

test('in the en locale the model shows the English half of each recorded text',async()=>{
 const seen={},note=(kind,text)=>{(seen[kind]??=new Set()).add(text);};
 const english=([zh,en])=>pair(zh,en,'en');
 await inLocale('en',()=>{
  const fresh=model();for(const symbol of SYMBOLS)for(const row of fresh.task(symbol).evidence)note('no_source_text',row.source);
  for(const all of [answered(),answered({public:false})])for(const symbol of SYMBOLS)for(const row of all.task(symbol).evidence)if(!kept(row.status))note('no_source_text',row.source);
  for(const failure of failures){const r=answered(failure.options);for(const [symbol,key,after] of failure.cells)if(after.status==='missing'){const row=item(r,symbol,key);assert.equal(row.text,english(failure.trace.text),`${failure.name}: ${symbol} ${key}`);note(failure.source,row.text);note('no_source_text',row.source);}}
 });
 const traced=failures.filter(failure=>failure.cells.some(([,,after])=>after.status==='missing'));
 assert.deepEqual(new Set(traced.map(failure=>failure.source)),new Set(Object.keys(sources)),'every source leaves a missing trace in some failure');
 const expectedText={no_source_text:new Set([english(coverage.no_source_text)])};
 for(const failure of traced)(expectedText[failure.source]??=new Set()).add(english(failure.trace.text));
 assert.deepEqual(seen,expectedText);
});

test('the public news and social answers reach the model through the served handler and ingestPublic, with the listed assets, requests, row limits and validity windows',()=>inLocale('zh',async()=>{
 assert.equal(answers.news.mode,'live_readonly');assert.equal(answers.social.mode,'live_readonly');
 // Which assets each feed can name: one fixed headline per asset through the dev's own parsers, and the three LunarCrush topics.
 assert.deepEqual(parseBlockBeats(flash(SYMBOLS),NOW_MS).map(row=>row.symbols),feeds.news.assets.map(symbol=>[symbol]));
 assert.deepEqual(parsePublicNews(rss(SYMBOLS),NOW_MS).items.map(row=>row.symbols),SYMBOLS.map(symbol=>[symbol]));
 assert.deepEqual(Object.values(PUBLIC_ASSETS),feeds.social.assets);
 for(const symbol of pub.assets)assert.deepEqual(pub.per_asset[symbol].providers,Object.values(feeds).filter(feed=>feed.assets.includes(symbol)).map(feed=>feed.provider),symbol);
 for(const symbol of pub.assets)assert.equal(pub.per_asset[symbol].provider,pub.per_asset[symbol].providers.join(' / '),symbol);
 assert.deepEqual(answers.news.items.filter(row=>row.provider_id===feeds.news.provider_id).flatMap(row=>row.data.symbols),feeds.news.assets);
 // What each feed asks the provider for, through the served handler, and how many rows and items it accepts.
 for(const [resource,feed] of Object.entries(feeds)){
  assert.equal(publicDataURL(resource,{limit:feed.requested.page_limit}),feed.requested.relay_path,resource);
  await asked(feed.requested,{});
  const most=feed.answer_maximum_items.value;assert.equal(publicQuery(resource,{limit:most}).limit,most,resource);assert.throws(()=>publicQuery(resource,{limit:most+1}),/INVALID_QUERY/,resource);
 }
 const flashRows=feeds.news.response_maximum_rows.value,many=n=>({status:0,data:{data:Array.from({length:n},(_,i)=>({id:201+i,title:TITLES.BTC,link:'https://m.theblockbeats.info/flash/'+(201+i),create_time:beijing(NOW_MS-60000)}))}});
 assert.equal(parseBlockBeats(many(flashRows),NOW_MS).length,flashRows);assert.throws(()=>parseBlockBeats(many(flashRows+1),NOW_MS),/BLOCKBEATS_INVALID_RESPONSE/);
 // The served handler cuts the merged news answer to the query limit: each publisher alone stays under it, both together exceed it.
 const newsMost=feeds.news.answer_maximum_items.value,coindeskRows=40;assert.ok(flashRows<newsMost&&coindeskRows<newsMost&&flashRows+coindeskRows>newsMost);
 const fullNews=(await served('news',{blockbeats:async()=>parseBlockBeats(many(flashRows),NOW_MS),coindesk:async()=>parsePublicNews(rss(Array(coindeskRows).fill('BTC')),NOW_MS).items})).body;
 assert.equal(fullNews.items.length,newsMost,`a news answer from ${flashRows} BlockBeats rows and ${coindeskRows} CoinDesk headlines`);
 for(const resource of ['posts','creators','category-posts']){
  const most=feeds.social.response_maximum_rows[resource];
  const failed=async n=>(await fetchLunarCrush(async url=>{
   const [,,,group,topic,part]=new URL(url).pathname.split('/'),kind=group==='category'?'category-posts':part==='v1'?'topic':part;
   if(kind==='topic')return Response.json({config:{topic},data:{topic,num_posts:1,num_contributors:1,interactions_24h:1,types_sentiment:{}}});
   const config=kind==='category-posts'?{category:topic}:kind==='creators'?null:{topic};
   return Response.json({config,data:kind===resource?Array.from({length:n},()=>({})):[]});
  },'fixture-key-not-a-token')).errors.filter(error=>error.resource===resource);
  const symbols=resource==='category-posts'?[feeds.social.discovery.error_symbol]:feeds.social.assets;
  assert.deepEqual(await failed(most),[],resource);assert.deepEqual(await failed(most+1),symbols.map(symbol=>({symbol,resource,code:'INVALID_DATA'})),resource);
 }
 // Research keeps BlockBeats headlines only: a news answer whose headlines all come from CoinDesk leaves every asset without a news fact.
 const coindeskOnly=(await served('news',{blockbeats:async()=>[],coindesk:newsReaders.coindesk})).body,notKept=feeds.news.not_kept.map(row=>row.provider_id);
 assert.ok(coindeskOnly.items.length>0&&coindeskOnly.items.every(row=>notKept.includes(row.provider_id)));
 const probe=model();probe.ingestPublic('news',coindeskOnly);for(const symbol of SYMBOLS)assert.deepEqual(probe.task(symbol).publicFacts,[],symbol);
 // Fact times and how long each fact keeps its cell, on the model's own clock.
 const news=feeds.news.evidence_valid_for_ms,topicRule=feeds.social.evidence_valid_for_ms.topic,kolRule=feeds.social.evidence_valid_for_ms.kol_post;
 const published=Object.fromEntries(parseBlockBeats(flash(SYMBOLS),NOW_MS).map(row=>[row.symbols[0],row.publishedAt]));
 const facts=[
  ...SYMBOLS.map(symbol=>({symbol,kind:'news',at:published[symbol],end:published[symbol]+news.value})),
  ...lunar.topics.map(topic=>({symbol:topic.symbol,kind:'topic',at:topic.asOf??lunar.observedAt,retrieved:topic.asOf===null,end:Math.min(lunar.observedAt,topic.asOf??lunar.observedAt)+topicRule.value})),
  ...lunar.posts.map(post=>({symbol:post.evidenceSymbol,kind:'kol',at:post.publishedAt,end:Math.min(lunar.observedAt+kolRule.observed_for_ms,post.publishedAt+kolRule.published_for_ms)}))
 ];
 assert.ok(facts.some(fact=>fact.kind==='kol'&&fact.end<lunar.observedAt+kolRule.observed_for_ms),'a KOL post that ends by its publication time');
 let clock=NOW;
 const reading=()=>{clock=NOW;const r=new MarketResearch({now:()=>clock});for(const resource of Object.keys(feeds))r.ingestPublic(resource,answers[resource]);return r;};
 const first=reading();
 for(const fact of facts){const held=first.task(fact.symbol).publicFacts.find(row=>row.kind===fact.kind);assert.ok(held,`${fact.symbol} ${fact.kind}`);assert.equal(held.at,fact.at,`${fact.symbol} ${fact.kind} time`);assert.equal(held.expires,fact.end,`${fact.symbol} ${fact.kind} end`);if(fact.kind==='topic')assert.equal(held.retrieved,fact.retrieved,`${fact.symbol} topic retrieval time`);}
 for(const fact of facts)for(const at of [fact.end-1000,fact.end]){
  const r=reading();clock=at/1000;
  const left=facts.filter(other=>other.symbol===fact.symbol&&other.end>at),row=item(r,fact.symbol,pub.dimension),label=`${fact.symbol} ${fact.kind} at ${at-NOW_MS} ms`;
  assert.deepEqual(r.task(fact.symbol).publicFacts.map(held=>held.kind).sort(),left.map(other=>other.kind).sort(),label);
  assert.equal(row.status,left.length?pub.kept_status:'missing',label);
  assert.equal(row.source,left.length?[...new Set(left.map(other=>other.kind==='news'?feeds.news.provider:feeds.social.provider))].join(' / '):shown(coverage.no_source_text),label);
 }
}));

test('recent posts from LunarCrush, Bluesky and Nostr retain their clocks and contribute no research facts, together or alone',async()=>{
 const {discovery,recent}=feeds.social;
 const did='did:plc:abcdefghijklmnopqrstuvwx',event='2'.repeat(64),pubkey='a'.repeat(64);
 const sky={id:'desk42',network:'Bluesky',creatorId:did,title:'Bitcoin transaction fees moved during the latest block',
  url:'https://bsky.app/profile/'+did+'/post/desk42',author:{acct:'desk.bsky.social',display_name:'Fixture desk',url:'https://bsky.app/profile/'+did,bot:null},
  symbols:['BTC'],publishedAt:NOW_MS-32_000,likes:0,reposts:1,replies:null};
 const note={id:event,network:'Nostr',creatorId:pubkey,title:'Ethereum validator participation in recent epochs',
  url:'https://primal.net/e/'+event,author:{acct:'aaaaaa…aaaa',display_name:null,url:null,bot:null},symbols:['ETH'],
  publishedAt:NOW_MS-20_000,likes:null,reposts:null,replies:null};
 const lunarRecent={...lunar,recentPosts:lunar.posts,discovery:{category:discovery.category,status:'OK'}};
 const fixtures=[
  {id:'lunarcrush-v4',reader:'lunarcrush',data:lunarRecent,post:lunar.posts[0],expiry:NOW_MS+3_600_000},
  {id:'bluesky-latest-v1',reader:'bluesky',data:{observedAt:NOW_MS-5000,posts:[sky],failedSymbols:[]},post:sky,expiry:NOW_MS-5000+recent.direct_valid_ms},
  {id:'nostr-relay-v1',reader:'nostr',data:{observedAt:NOW_MS-3000,posts:[note]},post:note,expiry:NOW_MS-3000+recent.direct_valid_ms}
 ];
 assert.deepEqual(fixtures.map(row=>row.id),recent.providers);
 assert.equal(publicDataURL('social',{limit:feeds.social.requested.page_limit,feed:'recent'}),recent.relay_path);
 for(const only of [null,...recent.providers]){
  const calls=[];
  const readers=Object.fromEntries(fixtures.map(row=>[row.reader,async()=>{
   calls.push(row.id);if(only&&only!==row.id)throw Error('OFFLINE_FIXTURE');return row.data;
  }]));
  const {status,body}=await served('social',readers,{feed:'recent'});
  assert.deepEqual(calls.sort(),[...recent.providers].sort());assert.equal(status,200);
  assert.equal(body.coverage.scope,recent.scope);assert.equal(body.quality,only?'partial':'fresh');
  assert.deepEqual(body.coverage.lunar?.discovery??null,!only||only==='lunarcrush-v4'?lunarRecent.discovery:null);
  const available=fixtures.filter(row=>!only||only===row.id).sort((a,b)=>b.post.publishedAt-a.post.publishedAt);
  assert.deepEqual(body.items.map(item=>[item.provider_id,item.data.symbols,item.event_time_ms,item.received_at_ms,item.valid_until_ms]),
   available.map(row=>[row.id,row.post.symbols,row.post.publishedAt,row.data.observedAt,row.expiry]));
  assert.ok(body.items.every(item=>item.data.kol===undefined));assert.equal(body.real_trading_connected,false);assert.equal(body.execution_binding,'NONE');
  const r=model();r.ingestPublic('social',body);
  for(const symbol of SYMBOLS){assert.deepEqual(r.task(symbol).publicFacts,[],symbol);assert.equal(r.handoff(symbol),null,symbol);}
 }
 const featured=await served('social',{lunarcrush:async()=>lunarRecent},{feed:'featured'});
 assert.equal(featured.status,200);assert.equal(featured.body.coverage.scope,feeds.social.featured_scope);
 assert.deepEqual(featured.body.sources.map(source=>source.provider_id),[feeds.social.provider_id]);
 const r=model();r.ingestPublic('social',featured.body);
 for(const symbol of SYMBOLS){
  const expected=symbol==='SOL'?['kol','topic']:['BTC','ETH'].includes(symbol)?['topic']:[];
  assert.deepEqual(r.task(symbol).publicFacts.map(fact=>fact.kind).sort(),expected,symbol);assert.equal(r.handoff(symbol),null,symbol);
 }
});
