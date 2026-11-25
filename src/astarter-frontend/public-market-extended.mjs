import {marginPadLiquidationsRequest} from './public-marginpad-liquidations.mjs';
const DAY=86_400_000;
const okx='https://www.okx.com/api/v5';
const mempool='https://mempool.space/api';
const stablecoinNetflow='eth.StablecoinExchangeNetflow';
const btcBlockTotals=Object.freeze({transactions:'totalTx',fees:'totalFee','miner-revenue':'totalReward'});
const btcPending=Object.freeze({mempool:'count','mempool-size':'vsize'});
export const DERIVATIVE_SYMBOLS=Object.freeze(['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','LINK','LTC','DOT','SUI']);
export const DERIVATIVE_VIEWS=Object.freeze(['funding','oi','liquidation','ratio']);
// Bitview balance bands are half-open. The first funded band begins at one satoshi.
const subBitcoinBands=['1_to_10','10_to_100','100_to_1k','1k_to_10k','10k_to_100k','100k_to_1m','1m_to_10m','10m_to_100m'].map(band=>band+'_sats');
const thousandBitcoinBands=['1k_to_10k_btc','10k_to_100k_btc','over_100k_btc'];
const positiveBalanceBands=[...subBitcoinBands,'1_to_10_btc','10_to_100_btc','100_to_1k_btc',...thousandBitcoinBands];
const balanceColumns=(bands,measure)=>bands.map(band=>'balance_'+band+'_'+measure).join(',');
const bitviewSeries={
 mvrv:['mvrv','Multiple','×'],sopr:['sopr_24h','Multiple','×'],'realized-price':['realized_price','Dollars','USD'],
 'realized-cap':['realized_cap','Dollars','USD'],nupl:['nupl','Ratio','ratio'],
 'lth-supply':['lth_supply','Bitcoin','BTC'],'sth-supply':['sth_supply','Bitcoin','BTC'],
 'lth-cost':['lth_realized_price','Dollars','USD'],'sth-cost':['sth_realized_price','Dollars','USD'],
 'profit-supply':['supply_in_profit_share','Percent','%'],'realized-profit':['realized_profit_sum_24h','Dollars','USD'],
 'realized-loss':['realized_loss_sum_24h','Dollars','USD'],cdd:['coindays_destroyed_sum_24h','CoinDays','BTC·d'],
 'spent-volume':['transfer_volume_sum_24h','Bitcoin','BTC'],'new-address':['new_address_count_sum_24h','Count','addresses'],
 nonzero:[balanceColumns(positiveBalanceBands,'address_count'),'Count','addresses'],
 'whale-balance':[balanceColumns(thousandBitcoinBands,'supply'),'Bitcoin','BTC'],
 shrimp:[balanceColumns(subBitcoinBands,'supply'),'Bitcoin','BTC'],
 'block-fees':['fees_sum_24h_usd,tx_count_sum_24h,block_count_sum_24h',['Dollars','Count','Count'],'USD']
};
export const CHAIN_METRICS=Object.freeze(['tvl','stablecoins','chains','hashrate','active-addresses','btc-supply','eth-gas','eth-transfers',
 'transactions','fees','miner-revenue','block-size','difficulty','mempool','mempool-size','stablecoin-netflow',...Object.keys(bitviewSeries)]);
const check=value=>{if(!value)throw Error('INVALID_PUBLIC_MARKET_DATA');};
const time=(value,now)=>Number.isSafeInteger(value)&&value>0&&value<=now+60_000;
const parseNumber=value=>typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value)?Number(value):NaN;
const ascending=rows=>rows.every((row,i)=>i===0||row.at>rows[i-1].at);
const address=/^0x[0-9a-f]{40}$/i;
const txHash=/^0x[0-9a-f]{64}$/i;
const wei=/^[1-9]\d{20,77}$/;
export const ETH_TRANSFER_RPC='https://ethereum-rpc.publicnode.com';
const rpcHome='https://ethereum.publicnode.com/';
const safeBlocks=18;
const quantity=value=>typeof value==='string'&&/^0x[0-9a-f]{1,64}$/i.test(value)?BigInt(value):null;

function derivativeSources(view,symbol){
 const family=symbol+'-USDT',instrument=family+'-SWAP';
 if(view==='funding')return [okx+'/public/funding-rate-history?instId='+instrument+'&limit=100'];
 if(view==='oi')return [
  okx+'/rubik/stat/contracts/open-interest-history?instId='+instrument+'&period=1D&limit=90',
  {url:okx+'/public/open-interest?instType=SWAP&instId='+instrument,optional:true}
 ];
 if(view==='ratio')return [okx+'/rubik/stat/contracts/long-short-account-ratio?ccy='+symbol+'&period=1D'];
 return [okx+'/public/liquidation-orders?instType=SWAP&instFamily='+family+'&state=filled&limit=50'];
}

function okxRows(raw,max){
 check(raw?.code==='0'&&Array.isArray(raw.data)&&raw.data.length<=max);
 return raw.data;
}

function openInterest(raw,instrument,now){
 const rows=okxRows(raw,1);
 if(!rows.length)return null;
 const row=rows[0],at=Number(row.ts),value=parseNumber(row.oiUsd);
 check(row.instId===instrument&&row.instType==='SWAP'&&time(at,now)&&Number.isFinite(value)&&value>=0);
 return {at,value};
}

function decodeDerivatives(parts,view,symbol,now){
 const instrument=symbol+'-USDT-SWAP';
 let rows,current=null;
 if(view==='liquidation'){
  rows=okxRows(parts[0],20).filter(row=>row.instId===instrument).flatMap(row=>{
   check(row.instType==='SWAP'&&Array.isArray(row.details)&&row.details.length<=50);
   return row.details.map(item=>({
    at:Number(item.ts),position:item.posSide,size:parseNumber(item.sz),bankruptcyPrice:parseNumber(item.bkPx)
   }));
  }).sort((a,b)=>b.at-a.at).slice(0,50);
 }else{
  rows=okxRows(parts[0],200).map(row=>{
   if(view==='funding'){
    check(row.instId===instrument&&row.instType==='SWAP');
    return {at:Number(row.fundingTime),value:parseNumber(row.realizedRate)*100};
   }
   check(Array.isArray(row)&&row.length>=(view==='oi'?4:2));
   return {at:Number(row[0]),value:parseNumber(row[view==='oi'?3:1])};
  }).sort((a,b)=>a.at-b.at).slice(-100);
  if(view==='oi'&&parts[1])try{current=openInterest(parts[1],instrument,now);}catch{}
 }
 const body={source:'OKX',symbol,instrument:view==='ratio'?null:instrument,view,rows,current};
 check(validateDerivativeBody(body,view,symbol,now));
 return body;
}

export function validateDerivativeBody(body,view,symbol,now){
 if(body?.source!=='OKX'||body.symbol!==symbol||body.view!==view||body.instrument!==(view==='ratio'?null:symbol+'-USDT-SWAP')||!Array.isArray(body.rows)||body.rows.length>(view==='liquidation'?50:100))return false;
 const current=body.current;
 if(current!==null&&(view!=='oi'||!time(current?.at,now)||!Number.isFinite(current.value)||current.value<0))return false;
 if(view==='liquidation')return body.rows.every((row,i,rows)=>time(row?.at,now)&&(!i||row.at<=rows[i-1].at)&&['long','short'].includes(row.position)&&Number.isFinite(row.size)&&row.size>0&&Number.isFinite(row.bankruptcyPrice)&&row.bankruptcyPrice>=0);
 return ascending(body.rows)&&body.rows.every(row=>time(row?.at,now)&&Number.isFinite(row.value)&&(view==='funding'||row.value>=0));
}

export function publicDerivativesRequest(params){
 const view=params.get('view'),symbol=params.get('symbol');
 if(params.size===2&&view==='venue-liquidations')return marginPadLiquidationsRequest(symbol);
 if(params.size!==2||!DERIVATIVE_VIEWS.includes(view)||!DERIVATIVE_SYMBOLS.includes(symbol))return null;
 return {
  key:'derivatives:'+view+':'+symbol,resource:'derivatives',
  policy:{urls:derivativeSources(view,symbol),parallel:view==='oi',interval:view==='liquidation'?30_000:60_000,maxBytes:100_000},
  decode:(parts,now)=>decodeDerivatives(parts,view,symbol,now)
 };
}

const chainSources=Object.freeze({
 ...Object.fromEntries(Object.entries(bitviewSeries).map(([metric,[series,,unit]])=>[metric,[
  'https://bitview.space/api/series/bulk?series=date,'+series+'&index=day1&start=-91','Bitview',unit
 ]])),
 hashrate:[mempool+'/v1/mining/hashrate/1m','mempool.space','EH/s'],
 difficulty:[mempool+'/v1/mining/hashrate/1m','mempool.space','difficulty'],
 'block-size':[mempool+'/v1/mining/blocks/sizes-weights/1m','mempool.space','bytes'],
 transactions:[mempool+'/v1/mining/reward-stats/144','mempool.space','transactions'],
 fees:[mempool+'/v1/mining/reward-stats/144','mempool.space','BTC'],
 'miner-revenue':[mempool+'/v1/mining/reward-stats/144','mempool.space','BTC'],
 mempool:[mempool+'/mempool','mempool.space','transactions'],
 'mempool-size':[mempool+'/mempool','mempool.space','vB'],
 'active-addresses':['https://api.blockchain.info/charts/n-unique-addresses?timespan=90days&format=json','Blockchain.com','addresses'],
 'btc-supply':['https://api.blockchain.info/charts/total-bitcoins?timespan=90days&format=json','Blockchain.com','BTC'],
 'eth-gas':['https://eth.blockscout.com/api/v2/stats','Blockscout','Gwei'],
 'stablecoin-netflow':['https://cryptokeyhole.com/charts/eth/?metric='+stablecoinNetflow,'CryptoKeyhole','USD'],
 'eth-transfers':['https://eth.blockscout.com/api/v2/advanced-filters?transaction_types=coin_transfer&amount_from=100','Blockscout','wei']
});
export const CHAIN_INSIGHT_MAX_AGE=Object.freeze({hashrate:3*DAY,difficulty:21*DAY,'block-size':DAY,transactions:300_000,fees:300_000,'miner-revenue':300_000,
 mempool:300_000,'mempool-size':300_000,'active-addresses':5*DAY,'btc-supply':3*DAY,'eth-gas':300_000,'eth-transfers':300_000,'stablecoin-netflow':3*DAY,
 ...Object.fromEntries(Object.keys(bitviewSeries).map(metric=>[metric,3*DAY]))});

function bitviewValue(value,unit){
 if(!Number.isFinite(value))return false;
 if(unit==='ratio')return value<=1; // NUPL has no lower bound.
 if(unit==='addresses')return Number.isSafeInteger(value)&&value>=0;
 if(unit==='%')return value>=0&&value<=100;
 return value>=0;
}

function bitviewDaily(raw,metric,now){
 const [columns,kinds,unit]=bitviewSeries[metric];
 const types=Array.isArray(kinds)?kinds:columns.split(',').map(()=>kinds);
 check(Array.isArray(raw)&&raw.length===types.length+1);
 const [dates,...series]=raw;
 check(dates?.type==='Date'&&dates.index==='day1'&&Number.isSafeInteger(dates.start)&&dates.start>=0&&Number.isSafeInteger(dates.end));
 check(Array.isArray(dates.data)&&dates.data.length===dates.end-dates.start&&dates.data.length<=91);
 check(series.every((column,i)=>column?.type===types[i]&&column.index==='day1'&&column.start===dates.start&&column.end===dates.end&&
  Array.isArray(column.data)&&column.data.length===dates.data.length));
 const today=Math.floor(now/DAY)*DAY,rows=[];let prior=null;
 for(const [i,date] of dates.data.entries()){
  check(typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date));
  const at=Date.parse(date);
  check(time(at,now)&&new Date(at).toISOString().slice(0,10)===date&&(prior===null||at===prior+DAY));
  prior=at;
  const values=series.map(column=>column.data[i]);
  for(const [index,value] of values.entries()){
   if(value===null)continue;
   check(Number.isFinite(value)&&(metric==='nupl'?value<=1:value>=0));
   if(types[index]==='Count')check(Number.isSafeInteger(value));
  }
  // A missing observation makes the whole day's calculation unknown.
  if(values.includes(null))continue;
  let value=values[0];
  if(metric==='block-fees'){
   const [fees,txs,blocks]=values;
   check(txs>=blocks);
   if(txs===blocks)continue;
   value=fees/(txs-blocks);
  }else if(values.length>1){
   // Accumulate address balances in satoshis before converting back to BTC.
   const factor=unit==='BTC'?100_000_000:1;
   const sum=values.reduce((total,part)=>total+Math.round(part*factor),0);
   check(Number.isSafeInteger(sum));
   value=sum/factor;
  }
  check(bitviewValue(value,unit));
  if(at<today)rows.push({at,value});
 }
 return rows.slice(-90);
}

function decodeChainInsight(raw,metric,now){
 const [url,source,unit]=chainSources[metric];
 let rows,asOf,blocks;
 if(metric==='eth-transfers'){
  check(Array.isArray(raw?.items)&&raw.items.length<=50);
  rows=raw.items.flatMap(item=>{
   check(typeof item?.type==='string'&&typeof item.status==='string');
   // The explorer may mix contract interactions into its native-transfer filter.
   if(item.type!=='coin_transfer'||item.status!=='success')return [];
   check(typeof item.value==='string'&&/^\d{1,78}$/.test(item.value));
   if(BigInt(item.value)<10n**20n)return [];
   const at=Date.parse(item.timestamp);
   if(at<now-DAY)return [];
   return [{at,hash:item.hash,from:item.from?.hash,to:item.to?.hash,wei:item.value}];
  }).sort((a,b)=>b.at-a.at);
  asOf=rows[0]?.at??null;
 }else if(Object.hasOwn(bitviewSeries,metric)){
  rows=bitviewDaily(raw,metric,now);
 }else if(metric==='stablecoin-netflow'){
  check(raw?.metric?.id===stablecoinNetflow&&raw.metric.unit===unit&&raw.interval==='24h'&&!raw.locked&&
   ['current','delayed'].includes(raw.state)&&raw.historyComplete===true&&Array.isArray(raw.points)&&raw.points.length<=90);
  const today=Math.floor(now/DAY)*DAY;
  rows=raw.points.flatMap(point=>{
   check(Number.isSafeInteger(point?.t));
   const at=point.t*1000;
   return point.finality==='final'&&point.v!==null&&at<today?[{at,value:parseNumber(point.v)}]:[];
  });
 }else if(metric==='eth-gas'){
  const gas=raw?.gas_prices;
  rows=[{at:Date.parse(raw?.gas_price_updated_at),value:gas?.average,slow:gas?.slow,fast:gas?.fast}];
 }else if(Object.hasOwn(btcBlockTotals,metric)){
  const amount=parseNumber(raw?.[btcBlockTotals[metric]]);
  check(Number.isSafeInteger(amount)&&amount>=0);
  blocks={from:raw?.startBlock,to:raw?.endBlock};
  rows=[{at:now,value:metric==='transactions'?amount:amount/1e8}];
 }else if(Object.hasOwn(btcPending,metric)){
  const amount=raw?.[btcPending[metric]];
  check(Number.isSafeInteger(amount)&&amount>=0);
  rows=[{at:now,value:amount}];
 }else if(metric==='difficulty'||metric==='block-size'){
  const difficulty=metric==='difficulty',series=difficulty?raw?.difficulty:raw?.sizes;
  check(Array.isArray(series)&&series.length<=3000);
  rows=series.map(point=>difficulty?{at:point.time*1000,value:point.difficulty}:{at:point.timestamp*1000,value:point.avgSize}).slice(-90);
 }else{
  const hashRate=metric==='hashrate',series=hashRate?raw?.hashrates:raw?.values;
  check(Array.isArray(series)&&series.length>0&&series.length<=3000&&(hashRate||raw.status==='ok'&&raw.unit===(metric==='btc-supply'?'BTC':'Unique Addresses')));
  rows=series.map(point=>hashRate?{at:point.timestamp*1000,value:point.avgHashrate/1e18}:{at:point.x*1000,value:point.y});
  check(ascending(rows)&&rows.every(row=>time(row.at,now)&&Number.isFinite(row.value)&&row.value>=0));
  // Issuance observations can be intraday. Sample the last actual observation per UTC date.
  rows=[...new Map(rows.map(row=>[Math.floor(row.at/DAY),row])).values()].slice(-90);
 }
 if(metric!=='eth-transfers')asOf=rows.at(-1)?.at;
 const body={metric,url,source,unit,asOf,rows,...(blocks?{blocks}:{})};
 check(validateChainInsight(body,metric,now));
 return body;
}

export function validateChainInsight(body,metric,now){
 const spec=chainSources[metric];
 if(!spec||body?.metric!==metric||body.unit!==spec[2]||!Array.isArray(body.rows))return false;
 if(metric==='eth-transfers'&&body.source==='PublicNode'){
  const sample=body.sample;
  if(body.url!==rpcHome||!Number.isSafeInteger(sample?.throughBlock)||sample.throughBlock<safeBlocks||
   sample.fromBlock!==sample.throughBlock-safeBlocks+1||!time(sample.throughAt,now)||sample.throughAt<now-DAY||
   body.rows.some(row=>row?.at>sample.throughAt))return false;
 }else if(body.url!==spec[0]||body.source!==spec[1]||body.sample!==undefined)return false;
 const rows=body.rows;
 if(metric==='eth-transfers')return rows.length<=50&&body.asOf===(rows[0]?.at??null)&&rows.every((row,i)=>time(row?.at,now)&&row.at>=now-DAY&&(!i||row.at<=rows[i-1].at)&&txHash.test(row.hash)&&address.test(row.from)&&address.test(row.to)&&typeof row.wei==='string'&&wei.test(row.wei)&&BigInt(row.wei)>=10n**20n);
 if(metric==='eth-gas')return rows.length===1&&body.asOf===rows[0]?.at&&time(body.asOf,now)&&['value','slow','fast'].every(key=>Number.isFinite(rows[0][key])&&rows[0][key]>=0);
 if(Object.hasOwn(btcBlockTotals,metric)&&(!Number.isSafeInteger(body.blocks?.from)||body.blocks.from<=0||
  !Number.isSafeInteger(body.blocks.to)||body.blocks.to!==body.blocks.from+143||rows.length!==1||body.asOf!==now))return false;
 if(Object.hasOwn(btcPending,metric)&&(rows.length!==1||body.asOf!==now||!Number.isSafeInteger(rows[0]?.value)))return false;
 if(metric==='stablecoin-netflow'){
  const today=Math.floor(now/DAY)*DAY;
  return rows.length>0&&rows.length<=90&&ascending(rows)&&body.asOf===rows.at(-1).at&&
   rows.every(row=>time(row?.at,now)&&row.at%DAY===0&&row.at>=today-91*DAY&&row.at<today&&Number.isFinite(row.value));
 }
 if(Object.hasOwn(bitviewSeries,metric))return rows.length>0&&rows.length<=90&&
  rows.every(row=>time(row?.at,now)&&row.at%DAY===0&&row.at<Math.floor(now/DAY)*DAY&&bitviewValue(row.value,body.unit))&&
  ascending(rows)&&body.asOf===rows.at(-1).at;
 return rows.length>0&&rows.length<=90&&ascending(rows)&&body.asOf===rows.at(-1).at&&rows.every(row=>time(row?.at,now)&&Number.isFinite(row.value)&&row.value>=0);
}

async function readSafeBlockTransfers(read,now){
 async function rpc(method,parameters){
  const body=JSON.stringify(parameters.map((params,i)=>({jsonrpc:'2.0',id:i+1,method,params})));
  const rows=await read({url:ETH_TRANSFER_RPC,method:'POST',headers:{'Content-Type':'application/json'},body,maxBytes:6_000_000});
  check(Array.isArray(rows)&&rows.length===parameters.length);
  const results=new Map(rows.map(row=>[row?.id,row]));
  return parameters.map((_,i)=>{
   const row=results.get(i+1);
   check(row?.jsonrpc==='2.0'&&!row.error&&row.result);
   return row.result;
  });
 }
 const [head]=await rpc('eth_getBlockByNumber',[['safe',false]]);
 const throughBlock=Number(quantity(head.number)),throughAt=Number(quantity(head.timestamp))*1000;
 check(Number.isSafeInteger(throughBlock)&&throughBlock>=safeBlocks&&time(throughAt,now())&&txHash.test(head.hash));
 const selectors=Array.from({length:safeBlocks},(_,i)=>['0x'+(throughBlock-i).toString(16),true]);
 const batches=[selectors.slice(0,6),selectors.slice(6,12),selectors.slice(12)];
 const blocks=(await Promise.all(batches.map(batch=>rpc('eth_getBlockByNumber',batch)))).flat();
 const candidates=blocks.flatMap((block,i)=>{
  const at=Number(quantity(block.timestamp))*1000;
  check(block.number===selectors[i][0]&&block.hash===(i?blocks[i-1].parentHash:head.hash)&&txHash.test(block.hash)&&
   time(at,now())&&at<=throughAt&&Array.isArray(block.transactions));
  return block.transactions.flatMap(tx=>{
   if(tx?.input!=='0x'||!tx.to)return [];
   const value=quantity(tx.value);check(value!==null);
   if(value<10n**20n)return [];
   check(tx.blockHash===block.hash&&txHash.test(tx.hash)&&address.test(tx.from)&&address.test(tx.to));
   return [{at,hash:tx.hash,from:tx.from,to:tx.to,wei:String(value),blockHash:block.hash}];
  });
 }).sort((a,b)=>b.at-a.at).slice(0,50);
 const receipts=candidates.length?await rpc('eth_getTransactionReceipt',candidates.map(row=>[row.hash])):[];
 const rows=candidates.flatMap(({blockHash,...row},i)=>{
  const receipt=receipts[i];
  check(receipt.transactionHash===row.hash&&receipt.blockHash===blockHash&&['0x0','0x1'].includes(receipt.status));
  return receipt.status==='0x1'?[row]:[];
 });
 const result={metric:'eth-transfers',source:'PublicNode',url:rpcHome,unit:'wei',asOf:rows[0]?.at??null,rows,
  sample:{fromBlock:throughBlock-safeBlocks+1,throughBlock,throughAt}};
 check(validateChainInsight(result,'eth-transfers',now()));
 return result;
}

export function publicChainInsightRequest(params,now=Date.now()){
 const metric=params.get('metric');
 if(params.size!==1||!Object.hasOwn(chainSources,metric))return null;
 const [url]=chainSources[metric];
 const sourceUrl=new URL(url);
 const netflow=metric==='stablecoin-netflow';
 if(netflow){
  const daySeconds=DAY/1000,today=Math.floor(now/DAY)*daySeconds;
  sourceUrl.pathname='/api/v1/series';
  sourceUrl.search=new URLSearchParams({metric:stablecoinNetflow,interval:'24h',start:today-90*daySeconds,end:today-1,limit:90});
 }
 const transfers=metric==='eth-transfers';
 // Restrict the explorer query to recent blocks so it can use its time index.
 if(transfers)sourceUrl.searchParams.set('age_from',new Date(Math.floor((now-DAY)/60_000)*60_000).toISOString());
 return {
  key:'chain-insight:'+metric,resource:'chain-insight',
  policy:{url:sourceUrl.href,interval:CHAIN_INSIGHT_MAX_AGE[metric]===300_000?60_000:600_000,maxBytes:250_000,
   ...(transfers?{cacheKey:'eth-transfers-v2',timeoutMs:12_000}:{})},
  decode:([raw],now)=>decodeChainInsight(raw,metric,now),
  ...(transfers?{async collect(read,clock){
   const primary=await read({url:sourceUrl.href,optional:true,timeoutMs:5000});
   if(primary)try{return decodeChainInsight(primary,metric,clock());}catch{}
   return readSafeBlockTransfers(read,clock);
  }}:{})
 };
}
