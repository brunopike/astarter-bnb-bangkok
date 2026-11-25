const DAY=86400000,MAX_CAPACITY=2100000000000000;
const primaryObserver='mempool.emzy.de',fallbackObserver='mempool.space';
const observerUrls=Object.fromEntries([primaryObserver,fallbackObserver].map(host=>[
 host,['1m','latest'].map(interval=>'https://'+host+'/api/v1/lightning/statistics/'+interval)
]));
export const LIGHTNING_MAX_AGE=3*DAY;
export const PUBLIC_LIGHTNING_SOURCE=Object.freeze({url:observerUrls[primaryObserver][0],interval:600000,stale:LIGHTNING_MAX_AGE,maxBytes:20000,format:'json'});
const coverage=observer=>({scope:'PUBLIC_LIGHTNING_GOSSIP_SNAPSHOT',observer,networkCoverageComplete:false,privateChannelsIncluded:false,fundingTransactionsResolvedOnly:true,timeBasis:'provider_daily_snapshot'});
const units=Object.freeze({lightning:'BTC',channels:'channels'});
const check=value=>{if(!value)throw Error('INVALID_LIGHTNING_STATISTICS');};
const count=value=>Number.isSafeInteger(value)&&value>=0;
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)||{},'value'));
const fixed=(value,expected)=>exact(value,Object.keys(expected))&&Object.keys(expected).every(key=>value[key]===expected[key]);
function btc(sats){const value=BigInt(sats),fraction=String(value%100000000n).padStart(8,'0').replace(/0+$/,'');return String(value/100000000n)+(fraction?'.'+fraction:'');}
function validPoint(at,channels,sats,receivedAt){return Number.isSafeInteger(at)&&at>0&&at%DAY===0&&at<=receivedAt+60000&&count(channels)&&count(sats)&&sats<=MAX_CAPACITY&&(channels===0)===(sats===0);}
function row(at,channelCount,sats,metric,sourceUrl){return {at,value:metric==='lightning'?sats/100000000:channelCount,capacitySats:String(sats),capacityBtc:btc(sats),channelCount,sourceUrl};}
function seriesRows(raw,metric,receivedAt,url){
 check(Array.isArray(raw)&&raw.length>0&&raw.length<=40);
 const rows=Array.from(raw,point=>{
  const at=point?.added*1000,channels=point?.channel_count,sats=point?.total_capacity;
  check(Number.isSafeInteger(point?.added)&&validPoint(at,channels,sats,receivedAt));return row(at,channels,sats,metric,url);
 }).sort((a,b)=>a.at-b.at);
 check(rows.every((point,i)=>i===0||point.at>rows[i-1].at)&&rows.at(-1).at-rows[0].at<=40*DAY);return rows;
}
function latestRows(raw,metric,receivedAt,url){
 const point=raw?.latest,iso=point?.added;
 check(typeof iso==='string'&&/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(iso));
 const at=Date.parse(iso);check(validPoint(at,point.channel_count,point.total_capacity,receivedAt)&&new Date(at).toISOString()===(iso.includes('.')?iso:iso.replace('Z','.000Z')));
 return [row(at,point.channel_count,point.total_capacity,metric,url)];
}
function provenance(rows,urls){return urls.flatMap(url=>{const used=rows.filter(point=>point.sourceUrl===url);return used.length?[{url,asOf:used.at(-1).at}]:[];});}
function finish(points,metric,receivedAt,observer){
 check(points.length>0);const rows=[...points].sort((a,b)=>a.at-b.at),asOf=rows.at(-1).at;
 check(Number.isSafeInteger(asOf+LIGHTNING_MAX_AGE));
 const body={metric,url:rows.at(-1).sourceUrl,source:observer,unit:units[metric],asOf,receivedAt,validUntil:asOf+LIGHTNING_MAX_AGE,
  coverage:coverage(observer),provenance:provenance(rows,observerUrls[observer]),rows};
 check(validateLightningStatistics(body,metric,receivedAt));return body;
}

// Daily observations of mempool's public network graph, including only funding-resolved channels.
// Missing daily observations are never interpolated; successful retrieval does not renew source age.
export function normalizeLightningStatistics(raw,metric,receivedAt){
 check(Object.hasOwn(units,metric)&&Number.isSafeInteger(receivedAt)&&receivedAt>0);
 return finish(seriesRows(raw,metric,receivedAt,observerUrls[fallbackObserver][0]),metric,receivedAt,fallbackObserver);
}

export function normalizeLightningSources(parts,metric,receivedAt,observer=fallbackObserver){
 check(Object.hasOwn(units,metric)&&Object.hasOwn(observerUrls,observer)&&Number.isSafeInteger(receivedAt)&&receivedAt>0&&Array.isArray(parts)&&parts.length===2);
 const [seriesUrl,latestUrl]=observerUrls[observer];
 let series=[],latest=[];
 try{series=seriesRows(parts[0],metric,receivedAt,seriesUrl);}catch{}
 try{latest=latestRows(parts[1],metric,receivedAt,latestUrl);}catch{}
 // A daily latest snapshot wins same-day conflicts as one whole observation, never mixed fields.
 const selected=[...new Map([...series,...latest].map(point=>[point.at,point])).values()].sort((a,b)=>a.at-b.at);
 check(selected.length>0);const asOf=selected.at(-1).at;
 return finish(selected.filter(point=>point.at>=asOf-40*DAY).slice(-40),metric,receivedAt,observer);
}

// An expired but authentic historical observation is valid data; callers must label its source age.
export function validateLightningStatistics(body,metric,now=Date.now()){
 try{
  if(!Object.hasOwn(units,metric)||!exact(body,['metric','url','source','unit','asOf','receivedAt','validUntil','coverage','provenance','rows'])||body.metric!==metric||!Object.hasOwn(observerUrls,body.source)||body.unit!==units[metric]||!fixed(body.coverage,coverage(body.source))||!Number.isSafeInteger(now)||now<=0||!Number.isSafeInteger(body.receivedAt)||body.receivedAt<=0||body.receivedAt>now+1000||!Array.isArray(body.rows)||body.rows.length<1||body.rows.length>40)return false;
  const urls=observerUrls[body.source],latestUrl=urls[1];
  if(!body.rows.every((row,i)=>{
   if(!exact(row,['at','value','capacitySats','capacityBtc','channelCount','sourceUrl'])||!urls.includes(row.sourceUrl)||typeof row.capacitySats!=='string'||!/^(?:0|[1-9]\d{0,15})$/.test(row.capacitySats))return false;
   const sats=Number(row.capacitySats);
   return validPoint(row.at,row.channelCount,sats,body.receivedAt)&&row.capacityBtc===btc(sats)&&row.value===(metric==='lightning'?sats/100000000:row.channelCount)&&(!i||row.at>body.rows[i-1].at);
  }))return false;
  const asOf=body.rows.at(-1).at;
  const adopted=provenance(body.rows,urls);
  return body.rows.filter(point=>point.sourceUrl===latestUrl).length<=1&&Array.isArray(body.provenance)&&body.provenance.length===adopted.length&&body.provenance.every((item,i)=>fixed(item,adopted[i]))&&body.url===body.rows.at(-1).sourceUrl&&asOf-body.rows[0].at<=40*DAY&&Number.isSafeInteger(asOf+LIGHTNING_MAX_AGE)&&body.asOf===asOf&&body.validUntil===asOf+LIGHTNING_MAX_AGE;
 }catch{return false;}
}

export function publicLightningRequest(params){
 if(!(params instanceof URLSearchParams)||params.size!==1||!Object.hasOwn(units,params.get('metric')))return null;
 const metric=params.get('metric');
 return {key:'chain-insight:'+metric,resource:'chain-insight',policy:PUBLIC_LIGHTNING_SOURCE,async collect(read,now){
  async function observe(observer){
   const parts=await Promise.all(observerUrls[observer].map(url=>read({url,optional:true,timeoutMs:3000})));
   try{return normalizeLightningSources(parts,metric,now(),observer);}catch{return null;}
  }
  const primary=await observe(primaryObserver);
  if(primary?.validUntil>now())return primary;
  const fallback=await observe(fallbackObserver);
  // Daily measurements from different public graph observers must never share a series.
  const best=fallback&&(!primary||fallback.asOf>primary.asOf)?fallback:primary;
  check(best);
  return best;
 }};
}
