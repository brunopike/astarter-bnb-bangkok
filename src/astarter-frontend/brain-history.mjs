import {reasoningRecords} from './brain-reasoning-memory.mjs';
import chain from './brain-evidence/chain-history.json' with {type:'json'};
import research from './brain-evidence/research-history.json' with {type:'json'};
import markets from './brain-evidence/market-history.json' with {type:'json'};
import tvl from './brain-evidence/chain-tvl-history.json' with {type:'json'};
import {brainAssetKey,brainCatalog} from './brain-asset-data.mjs';
import {traderRecords,gainNode,lossNode} from './brain-trader-history.mjs';
import rankedHistory from './brain-evidence/ranked-price-history.json' with {type:'json'};
import daily from './brain-evidence/daily-markets.json' with {type:'json'};

const number=new Intl.NumberFormat('en-US',{maximumSignificantDigits:7});
const format=value=>number.format(value);
const day=stamp=>new Date(stamp).toISOString().slice(0,10);
const iso=seconds=>new Date(seconds*1000).toISOString();
const signed=value=>(value>0?'+':'')+value.toFixed(2)+'%';
const catalogUrl='/brain-evidence/asset-catalog.json';
const catalogKeys=new Map(brainCatalog.map(asset=>[brainAssetKey(asset),asset]));

function catalogRecords(asset) {
  const {symbol,chain,address,provider,venue,receivedAt,price,volume,liquidity}=asset;
  const key=brainAssetKey(asset),subject=[symbol,chain].filter(Boolean).join(' · ');
  const context={scopeKeys:[key],eventAt:asset.asOf||receivedAt,knownAt:receivedAt,source:provider,sourceUrl:catalogUrl,upstreamUrl:asset.sourceUrl};
  const identity=address||asset.id;
  const volumeText=Number.isFinite(volume)?' · 24h $'+format(volume):'';
  const amount=Number.isFinite(price)?'$'+format(price):'—';
  const quote=(venue||provider)+' · '+amount+volumeText;
  const body=address
    ?[subject+' 在 '+venue+' 的池报价为 '+amount+'。合约 '+address+'。',subject+' was quoted at '+amount+' on '+venue+'. Contract '+address+'.']
    :[subject+' 的聚合报价为 '+amount+'，来源资产 ID 为 '+identity+'。',subject+' had an aggregate quote of '+amount+' under provider asset ID '+identity+'.'];
  const facets={2:[quote,quote],6:[quote,quote],9:[quote,quote]};
  const nodes=[1,2,5,6,7,9,10];
  if(Number.isFinite(liquidity)){
    nodes.push(8);
    facets[8]=[venue+' 池在采集时记录 $'+format(liquidity)+' 流动性。该数值覆盖这一个池，估算订单滑点还需指定交易方向和数量。',
      'The '+venue+' pool reported $'+format(liquidity)+' of liquidity. Estimating slippage also requires a trade size and direction.'];
  }
  const boundary=[subject+' 这份公开行情只含报价与市场统计。用户是否下单、成交数量和收益均未知。',
    'This '+subject+' market archive contains quotes and market statistics. User orders, fills and P&L are unknown.'];
  return [
    {...context,id:'capture/'+key,kind:'capture',nodes,title:[subject+' · 报价存档',subject+' · archived quote'],body,facets},
    {...context,id:'receipt-scope/'+key,kind:'coverage',nodes:[11,12],title:[subject+' · 回执核对范围',subject+' · receipt coverage'],body:boundary,
      facets:{12:[subject+' 的公开行情没有 AI 交易授权 ID、订单号或成交回执，无法据此确认自动交易。','This '+subject+' public quote carries no LensWave mandate ID, order ID or fill receipt to verify an automated trade.']}}
  ];
}

function marketRecords(key,asset,window) {
  const bars=window.candles,first=bars[0],last=bars.at(-1);
  const quote=window.priceUnit||asset.priceUnit;
  const market=window.market||asset.market,volumeUnit=window.volumeUnit||asset.volumeUnit;
  const assetName=catalogKeys.get(key)?.symbol||asset.symbol;
  const identity=catalogKeys.get(key);
  const pool=asset.kind==='dex-pool';
  const venue=pool?assetName+' @ '+asset.venue+' · '+market:market;
  const network=identity?.chain;
  const subject=identity?.address?assetName+' · '+network[0].toUpperCase()+network.slice(1):venue;
  const low=Math.min(...bars.map(bar=>bar[3])),high=Math.max(...bars.map(bar=>bar[2]));
  const quantity=bars.reduce((sum,bar)=>sum+bar[5],0);
  const range=format(low)+'–'+format(high)+' '+quote;
  const close=format(last[4])+' '+quote,open=format(first[1])+' '+quote;
  const body=[venue+' 首日开盘 '+open+'，末日收盘 '+close+'。'+bars.length+' 日价格区间为 '+range+'。',
    venue+' opened this '+bars.length+'-day UTC window at '+open+' and closed at '+close+'. The traded range was '+range+'.'];
  const heading=[subject+' · '+bars.length+' 日行情',subject+' · '+bars.length+'-day market'];
  const data={id:'bars/'+key+'/'+window.id,kind:'market',nodes:[0,2,3,7,9,10],scopeKeys:[key],title:heading,body,closes:bars.map(bar=>bar[4]),
    candles:bars,volumeUnit,priceUnit:quote,observationEndAt:iso(last[0]),availabilityBasis:'historical_reconstruction',eventAt:window.startAt,knownAt:window.cutoffAt,source:asset.provider,sourceUrl:window.snapshotSourceUrl,
    facets:{2:[body[0]+(pool?'全池累计成交额为 ':'累计成交量为 ')+format(quantity)+' '+volumeUnit+'。',body[1]+(pool?' Pool-wide turnover was ':' Volume was ')+format(quantity)+' '+volumeUnit+'.'],
      3:[venue+' 的历史观察区间为 '+range+'。若要判断后续价格是否突破，需要同一市场的新成交；这组日线没有可执行盘口深度。',
         'The observed range on '+venue+' was '+range+'. A later breakout requires a new trade on that market. These candles contain no executable depth.'],
      7:[day(window.startAt)+' 至 '+day(last[0]*1000)+' 的 '+bars.length+' 根日线均已收盘，观察截止时点按 UTC 计算。',
         bars.length+' completed daily candles cover '+day(window.startAt)+' through '+day(last[0]*1000)+' UTC.'],
      9:[asset.provider+' · '+venue+'，报价单位 '+quote+'，成交量单位 '+volumeUnit+'。',asset.provider+' · '+venue+'; prices in '+quote+', volume in '+volumeUnit+'.'],
      10:['原始记录含 '+bars.length+' 组开高低收和成交量，范围限于 '+venue+'。该窗口没有订单簿。',
          'The archive has '+bars.length+' OHLCV observations for '+venue+'. It contains no order book.']}};
  if(quote==='USD'){
    data.nodes.push(6);
    data.facets[6]=[venue+' 末日收盘 '+close+'，该日低点 '+format(last[3])+'、高点 '+format(last[2])+' USD。',
      venue+' closed at '+close+' on the final day, with a low of '+format(last[3])+' and a high of '+format(last[2])+' USD.'];
  }
  const next=window.reviewCandle;
  if(!next)return [data];
  const move=signed(100*(next[4]/last[4]-1));
  return [data,{id:'review/'+key+'/'+window.id,kind:'review',nodes:[4,13],scopeKeys:[key],
    availabilityBasis:'historical_reconstruction',eventAt:iso(next[0]),knownAt:window.reviewAt,source:asset.provider,sourceUrl:window.sourceUrl,baselineUrl:window.snapshotSourceUrl,
    title:[subject+' · 次日复盘',subject+' · next-day review'],
    body:[venue+' 从观察截止的 '+close+' 到次日收盘 '+format(next[4])+' '+quote+'，收盘变动 '+move+'。这是市场价格变化。',
      venue+' moved from the cutoff close of '+close+' to '+format(next[4])+' '+quote+' at the next close ('+move+'). This measures the market move.']}];
}

function networkRecord(key,network,point) {
  const close=iso(point.at),amount='$'+format(point.tvlUsd);
  const change=point.priorTvlUsd>0?signed(100*(point.tvlUsd/point.priorTvlUsd-1)):null;
  const name=network.name;
  return {id:'tvl/'+key+'/'+day(close),kind:'network',tvlPoint:point,scopeKeys:['chain/'+key],nodes:[8],
    availabilityBasis:'historical_reconstruction',eventAt:close,knownAt:iso(point.at+86400),source:tvl.source,sourceUrl:network.sourceUrl,
    title:[name+' · 链上锁仓量',name+' · network TVL'],
    body:[name+' 链的 DeFi 锁仓量为 '+amount+(change?'，较七日前 '+change:'')+'。此值按全链协议汇总。单笔交易的可成交深度需查具体交易池或盘口。',
      name+' had '+amount+' in DeFi TVL'+(change?' ('+change+' versus seven days earlier)':'')+'. This network-wide total does not measure executable depth for a trade.']};
}

// Each note points to evidence records. The graph, note tabs and provenance all
// retain the same record identities across quote refreshes and language changes.
const records=[...chain.records,...research.records,...brainCatalog.flatMap(catalogRecords),...traderRecords,...reasoningRecords];
for(const asset of rankedHistory.assets){
  const {key,symbol,prices,rank,marketCap,quoteAt}=asset;
  records.push({id:'ranked/'+key+'/'+day(quoteAt),kind:'sample',nodes:[0,2,6,7,9,10],scopeKeys:[key],
    eventAt:quoteAt,knownAt:rankedHistory.receivedAt,source:'CoinGecko',sourceUrl:'/brain-evidence/ranked-price-history.json',upstreamUrl:rankedHistory.sourceUrl,
    title:[symbol+' · 七日价格样本',symbol+' · seven-day price samples'],samplePrices:prices,
    body:['快照市值 $'+format(marketCap)+'，排名 #'+rank+'。七日窗口共 '+prices.length+' 个美元报价样本，按来源顺序编号。',
      'Market cap at capture was $'+format(marketCap)+', rank #'+rank+'. The seven-day window contains '+prices.length+' USD price samples in source order.']});
}
// Adding today's bars must preserve both the old point IDs and earlier replay cutoffs.
export function dailyMarketRecords(asset,initialCapture){
  const months=new Map(), captures=[...(asset.captures||[])].sort((a,b)=>a.start-b.start), result=[];
  let cursor=0;
  for(const bar of asset.bars){
    const time=bar[0],month=day(time*1000).slice(0,7);
    while(cursor<captures.length&&captures[cursor].end<time)cursor++;
    const batch=captures[cursor],added=batch&&batch.start<=time;
    const key=added?month+'/'+batch.start:month;
    if(!months.has(key))months.set(key,{knownAt:added?batch.retrievedAt:initialCapture,month,bars:[]});
    months.get(key).bars.push(bar);
  }
  for(const [key,{month,bars,knownAt}] of months){
    const first=bars[0],last=bars.at(-1),label=asset.symbol+' · '+month;
    const windowUrl=new URL(asset.sourceUrl);
    if(windowUrl.hostname==='api.exchange.coinbase.com'){
      windowUrl.searchParams.set('start',iso(first[0]));windowUrl.searchParams.set('end',iso(last[0]+86400));
    }else if(windowUrl.hostname==='data-api.binance.vision'){
      windowUrl.searchParams.set('startTime',String(first[0]*1000));windowUrl.searchParams.set('endTime',String((last[0]+86400)*1000-1));
    }
    result.push({id:'daily/'+asset.key+'/'+key,kind:'bars',nodes:[0,2,7,9,10,...(asset.quote==='USD'?[6]:[])],scopeKeys:[asset.key],
      eventAt:iso(first[0]),observationEndAt:iso(last[0]),knownAt,source:asset.venue,sourceUrl:windowUrl.href,
      candles:bars,closes:bars.map(b=>b[4]),volumeUnit:asset.symbol,priceUnit:asset.quote,
      title:[label+' 日线',label+' daily bars'],body:[asset.market+' · '+bars.length+' 根已收盘日线。窗口首日开盘 '+format(first[1])+'，末日收盘 '+format(last[4])+' '+asset.quote+'。',
        asset.market+' · '+bars.length+' closed UTC daily bars. First open '+format(first[1])+', last close '+format(last[4])+' '+asset.quote+'.']});
  }
  return result;
}
for(const asset of daily.assets)records.push(...dailyMarketRecords(asset,daily.retrievedAt));
for(const [key,asset] of Object.entries(markets.assets)){
  for(const window of asset.windows)records.push(...marketRecords(key,asset,window));
}
for(const [key,network] of Object.entries(tvl.networks)){
  for(const point of network.points)records.push(networkRecord(key,network,point));
}
const index=new Map(),byScope=new Map();
for(const record of records){
  for(const key of new Set(['all',...record.scopeKeys])){
    if(!index.has(key)){
      index.set(key,Array.from({length:lossNode+1},()=>[]));
      byScope.set(key,[]);
    }
    byScope.get(key).push(record);
    const nodes=key==='eth-merge' && record.archiveNodes?record.archiveNodes:record.nodes;
    for(const node of nodes)index.get(key)[node].push(record);
  }
}
const newest=(a,b)=>Date.parse(b.knownAt)-Date.parse(a.knownAt)||Date.parse(b.eventAt)-Date.parse(a.eventAt)||a.id.localeCompare(b.id);
for(const notes of index.values())for(const list of notes)list.sort(newest);

for(const list of byScope.values())list.sort(newest);

export function getMemoryIndex(key,asOf,network) {
  const own=byScope.get(key)||[];
  const context=key!=='all'&&network?byScope.get('chain/'+network):null;
  const list=context?.length?[...new Set([...own,...context])].sort(newest):own;
  const cutoff=Date.parse(asOf);
  return list.filter(r=>Date.parse(r.knownAt)<=cutoff && Date.parse(r.eventAt)<=cutoff);
}

export function getNodeHistory(key,node,asOf,network=null) {
  const cutoff=Date.parse(asOf);
  if(!Number.isFinite(cutoff))return [];
  const own=index.get(key==='eth-merge' && node>=gainNode?'coin:ethereum':key)?.[node]||[];
  const context=key!=='all' && network ? index.get('chain/'+network)?.[node] : null;
  const list=context?.length?[...own,...context].sort(newest):own;
  return list.filter(record=>Date.parse(record.knownAt)<=cutoff && Date.parse(record.eventAt)<=cutoff);
}

export function defaultHistoryRecord(list,node) {
  if(node===gainNode||node===lossNode)return list.find(record=>record.collection==='wallet')||list[0];
  const preferred={0:'decision',3:'decision',4:'decision-review',13:'reaction'}[node];
  const memory=preferred && list.find(r=>r.kind===preferred);
  if(memory)return memory;
  if([3,4,13].includes(node)){
    const example=list.find(record=>record.collection==='wallet');
    if(example)return example;
  }
  // Start with the piece of evidence the node asks for. The picker always
  // includes every eligible record in chronological order.
  if(node===8)return list.find(record=>record.kind==='capture')||list[0];
  if(node===2 || node===6 || node===9)return list.find(record=>record.kind==='market'||record.evidenceType==='closed_candles')||list[0];
  return list.find(record=>!['market','capture','coverage','network'].includes(record.kind))||list[0];
}
