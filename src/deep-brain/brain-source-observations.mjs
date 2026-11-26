import {createHash,randomUUID} from 'node:crypto';
import {link,mkdir,readFile,readdir,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {gzip,gunzip} from 'node:zlib';
import {setTimeout as sleep} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {forwardDirectory} from './brain-proof-forward.mjs';

export const SOURCE_WINDOW_DAYS=91;
const DAY=86400000,version='venue-source-observation-v1';
const names=['open','high','low','close','volume'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pack=promisify(gzip),unpack=promisify(gunzip);
const iso=ms=>new Date(ms).toISOString();
const isHash=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
function exactJSON(bytes){
  return JSON.parse(bytes,(key,value,context)=>{
    if(typeof value!=='number')return value;
    if(!context?.source)throw Error('Exact source numbers require Node.js 22 or newer');
    return context.source;
  });
}
// The 17 markets usually share one archive. Rehash bytes on every read so a
// changed file cannot reuse the parsed series. Retain only the latest archive.
let parsedArchive=null;
function parseArchive(bytes){
  const bytesSha=hash(bytes);
  if(parsedArchive?.bytesSha!==bytesSha)parsedArchive={bytesSha,archiveSha256:hash(JSON.stringify(JSON.parse(bytes))),exact:exactJSON(bytes)};
  return parsedArchive;
}
function decimal(input){
  const text=String(input);
  const parts=text.match(/^(\d{1,60})(?:\.(\d{1,60}))?(?:[Ee]([+-]?\d{1,2}))?$/);
  if(!parts)throw Error('Invalid decimal');
  const fraction=parts[2]??'',digits=parts[1]+fraction,point=parts[1].length+Number(parts[3]??0);
  const whole=point<=0?'0':digits.slice(0,point).padEnd(point,'0');
  const tail=(point<0?'0'.repeat(-point)+digits:digits.slice(point)).replace(/0+$/,'');
  return whole.replace(/^0+(?=\d)/,'')+(tail?'.'+tail:'');
}
function le(a,b){
  const [left,lf='']=a.split('.'),[right,rf='']=b.split('.');
  if(left.length!==right.length)return left.length<right.length;
  if(left!==right)return left<right;
  const size=Math.max(lf.length,rf.length);
  return lf.padEnd(size,'0')<=rf.padEnd(size,'0');
}
function values(items){
  if(items.length!==5)throw Error('Invalid OHLCV count');
  const v=items.map(decimal),[open,high,low,close,volume]=v;
  if(low==='0' || volume==='0' || !le(low,open) || !le(open,high) || !le(low,close) || !le(close,high))throw Error('Invalid OHLCV');
  return v;
}
function integer(value){
  if(!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)))throw Error('Invalid timestamp');
  return Number(value);
}
function requestUrl(asset,first,end){
  let origin;
  try{origin=new URL(asset.sourceUrl);}catch{return null;}
  if(!/^[A-Z0-9]{1,24}$/.test(asset.symbol))return null;
  if(asset.venue==='Binance Spot' && asset.quote==='USDT' && asset.market===asset.symbol+'USDT' &&
    origin.origin==='https://data-api.binance.vision' && origin.pathname==='/api/v3/klines' &&
    origin.searchParams.get('symbol')===asset.market && origin.searchParams.get('interval')==='1d'){
    const params=new URLSearchParams({symbol:asset.market,interval:'1d',startTime:first,endTime:end-1,limit:SOURCE_WINDOW_DAYS});
    return 'https://data-api.binance.vision/api/v3/klines?'+params;
  }
  if(asset.venue==='Coinbase Exchange' && asset.quote==='USD' && asset.market===asset.symbol+'-USD' &&
    origin.origin==='https://api.exchange.coinbase.com' && origin.pathname==='/products/'+asset.market+'/candles' &&
    origin.searchParams.get('granularity')==='86400'){
    const params=new URLSearchParams({start:iso(first),end:iso(end-1),granularity:'86400'});
    return 'https://api.exchange.coinbase.com/products/'+asset.market+'/candles?'+params;
  }
  return null;
}
function rowsInWindow(rows,format,first,end){
  if(!Array.isArray(rows))throw Error('Invalid candle response');
  const days=new Map();
  for(const row of rows){
    if(!Array.isArray(row) || row.length<6)throw Error('Invalid candle');
    const binance=format==='Binance Spot';
    const at=integer(row[0])*(binance?1:1000);
    if(at%DAY!==0)throw Error('Misaligned candle');
    if(at<first)continue; // Coinbase sometimes includes an earlier bucket.
    if(at>=end || days.has(at))throw Error('Unexpected or duplicate candle');
    if(binance && integer(row[6])!==at+DAY-1)throw Error('Incomplete UTC candle');
    if(!binance && row.length!==6)throw Error('Invalid candle fields');
    days.set(at,values(format==='Coinbase Exchange'?[row[3],row[2],row[1],row[4],row[5]]:row.slice(1,6)));
  }
  return days;
}
function compare(doc,asset,raw,captured){
  const first=Date.parse(doc.windowStartAt),end=Date.parse(doc.windowEndAt)+1;
  let local,remote,error;
  try{local=rowsInWindow(asset.bars,'archive',first,end);}catch{error='invalid_archive';}
  if(!doc.sourceUrl)error='unsupported_market';
  else if(captured>Date.parse(doc.startedAt) || !Number.isFinite(captured))error='invalid_archive_clock';
  if(!error && doc.httpStatus===200 && raw){
    try{remote=rowsInWindow(exactJSON(raw),asset.venue,first,end);}catch{error='invalid_venue_response';}
  }
  const checks=[];
  for(let at=first;at<end;at+=DAY){
    const a=local?.get(at),b=remote?.get(at);
    const fields=a && b?names.filter((field,i)=>a[i]!==b[i]):[];
    const status=!a?'missing_archive':!b?'missing_venue':fields.length?'conflict':'matched';
    checks.push({openAt:iso(at),status,...(fields.length?{fields}:{} )});
  }
  const matchedBars=checks.filter(r=>r.status==='matched').length;
  let status='unavailable',reason=error??doc.transportError;
  if(!reason && checks.some(r=>r.status==='conflict')){status='conflict';reason='ohlcv_mismatch';}
  else if(!reason && (!local.has(end-DAY) || Date.parse(doc.observedAt)>=end+DAY)){status='stale';reason='outdated_window';}
  else if(!reason && matchedBars===SOURCE_WINDOW_DAYS){status='matched';reason='all_candles_match';}
  else if(!reason)reason=doc.httpStatus!==200?'venue_http_error':local.size<SOURCE_WINDOW_DAYS?'archive_window_incomplete':'venue_window_incomplete';
  return {status,reason,matchedBars,totalBars:SOURCE_WINDOW_DAYS,checks};
}
function blob(dir,group,id){
  if(!isHash(id))throw Error('Invalid observation digest');
  return path.join(dir,'source-observations',group,id+'.gz');
}
async function readBlob(dir,group,id){
  const data=await unpack(await readFile(blob(dir,group,id)));
  if(hash(data)!==id)throw Error('Observation blob digest mismatch');
  return data;
}
async function publish(file,data){
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(tmp,data,{flag:'wx',mode:0o600,flush:true});
    try{await link(tmp,file);return true;}catch(error){if(error.code!=='EEXIST')throw error;return false;}
  }finally{await unlink(tmp).catch(err=>{if(err.code!=='ENOENT')throw err;});}
}
async function saveBlob(dir,group,data){
  const id=hash(data),file=blob(dir,group,id);
  // A second job may already have stored these bytes. Check the winner's
  // content before a new observation references it.
  if(!await publish(file,await pack(data,{level:3})))await readBlob(dir,group,id);
  return id;
}
async function boundedBody(response){
  const sizeLimit=256*1024, reader=response.body?.getReader();
  if(!reader)return Buffer.alloc(0);
  let size=0;
  const parts=[];
  for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    size+=value.length;
    if(size>sizeLimit){await reader.cancel();throw Error('response_too_large');}
    parts.push(value);
  }
  return Buffer.concat(parts,size);
}
async function fetchVenue(sourceUrl,{clock,fetchImpl,dir,timeoutMs,retryDelayMs}){
  const attempts=[];
  let raw=null,transportError=null,httpStatus=null,rawSha256=null;
  for(let count=0;count<2 && sourceUrl;count++){
    const startedAt=iso(clock());
    let retry=true,delay=retryDelayMs;
    raw=null;transportError=null;rawSha256=null;httpStatus=null;
    try{
      const response=await fetchImpl(sourceUrl,{redirect:'error',signal:AbortSignal.timeout(timeoutMs),
        headers:{Accept:'application/json','User-Agent':'Astarter-source-check/1.0'}});
      httpStatus=response.status;
      raw=await boundedBody(response);
      retry=httpStatus===429 || httpStatus>=500;
      if(response.headers.has('retry-after')){
        const value=response.headers.get('retry-after'),amount=/^\d+$/.test(value)?Number(value)*1000:Date.parse(value)-clock();
        if(!Number.isFinite(amount) || amount>2000)retry=false;
        else delay=Math.max(delay,amount);
      }
    }catch(error){
      transportError=error.message==='response_too_large'?'response_too_large':
        ['TimeoutError','AbortError'].includes(error.name)?'venue_timeout':'venue_connection_error';
      if(transportError==='response_too_large')retry=false;
    }
    if(raw)rawSha256=await saveBlob(dir,'responses',raw);
    attempts.push({startedAt,completedAt:iso(clock()),httpStatus,rawSha256,transportError});
    if(!retry || count===1)break;
    if(delay>0)await sleep(delay);
  }
  return {raw,attempts,httpStatus,transportError,rawSha256};
}
function marketIndex(dir,key,date){return path.join(dir,'source-observations','markets',hash(key),date);}

export async function collectSourceObservations(archiveBytes,{
  dir=forwardDirectory(),assetKey,clock=Date.now,fetchImpl=fetch,timeoutMs=8000,retryDelayMs=300
}={}){
  if(!Buffer.isBuffer(archiveBytes) && typeof archiveBytes!=='string')throw Error('Original archive JSON bytes required');
  if(!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>15000 ||
    !Number.isInteger(retryDelayMs) || retryDelayMs<0 || retryDelayMs>2000)throw Error('Invalid venue request limits');
  const bytes=Buffer.from(archiveBytes),{exact,archiveSha256}=parseArchive(bytes);
  if(!Array.isArray(exact.assets) || !exact.assets.length || exact.assets.some(a=>!a?.key || typeof a.key!=='string') ||
    new Set(exact.assets.map(a=>a.key)).size!==exact.assets.length)throw Error('Archive market mappings are missing or ambiguous');
  const assets=assetKey?exact.assets.filter(a=>a.key===assetKey):exact.assets;
  if(!assets.length)throw Error('Unknown archive market');
  const archiveBytesSha256=await saveBlob(dir,'archives',bytes);
  const captured=Date.parse(exact.updatedAt??exact.retrievedAt),observations=new Array(assets.length);
  let index=0;
  async function worker(){
    while(index<assets.length){
      const position=index++,asset=assets[position],start=clock(),startedAt=iso(start);
      const end=Math.floor(start/DAY)*DAY,first=end-SOURCE_WINDOW_DAYS*DAY,sourceUrl=requestUrl(asset,first,end);
      const {raw,...network}=await fetchVenue(sourceUrl,{clock,fetchImpl,dir,timeoutMs,retryDelayMs});
      const observedAt=iso(clock());
      if(Date.parse(observedAt)<start)throw Error('Collection clock moved backward');
      const doc={version,assetKey:asset.key,venue:asset.venue,market:asset.market,quote:asset.quote,sourceUrl,
        startedAt,observedAt,windowStartAt:iso(first),windowEndAt:iso(end-1),archiveSha256,archiveBytesSha256,...network};
      Object.assign(doc,compare(doc,asset,raw,captured));
      const id=await saveBlob(dir,'records',Buffer.from(JSON.stringify(doc)));
      const date=iso(end).slice(0,10),indexFile=path.join(marketIndex(dir,asset.key,date),String(Date.parse(observedAt))+'-'+id);
      await publish(indexFile,id);
      observations[position]={id,...doc};
    }
  }
  await Promise.all(Array.from({length:Math.min(3,assets.length)},worker));
  return {observations,counts:Object.fromEntries(['matched','conflict','stale','unavailable'].map(s=>[s,observations.filter(o=>o.status===s).length]))};
}

function cutoff(value){
  if(value===undefined)return Infinity;
  const t=typeof value==='number'?value:Date.parse(value);
  if(!Number.isSafeInteger(t))throw Error('Invalid observation cutoff');
  return t;
}
export function verifySourceObservation(observation,rawResponseBytes,originalArchiveBytes,{assetKey,archiveSha256,before,id,date}={}){
  const {id:actual,...doc}=observation;
  if(doc.version!==version || actual!==hash(JSON.stringify(doc)) || (id!==undefined && id!==actual) ||
    (assetKey!==undefined && assetKey!==doc.assetKey) || (archiveSha256!==undefined && archiveSha256!==doc.archiveSha256))
    throw Error('Observation identity mismatch');
  const start=Date.parse(doc.startedAt),observed=Date.parse(doc.observedAt),end=Math.floor(start/DAY)*DAY,first=end-SOURCE_WINDOW_DAYS*DAY;
  if(!Number.isSafeInteger(start) || !Number.isSafeInteger(observed) || start>observed || observed>cutoff(before) ||
    iso(first)!==doc.windowStartAt || iso(end-1)!==doc.windowEndAt || (date!==undefined && iso(end).slice(0,10)!==date))
    throw Error('Observation window mismatch');
  if(!Buffer.isBuffer(originalArchiveBytes) && typeof originalArchiveBytes!=='string')throw Error('Original archive bytes required');
  const bytes=Buffer.from(originalArchiveBytes);
  const {exact,archiveSha256:capturedHash,bytesSha}=parseArchive(bytes);
  if(bytesSha!==doc.archiveBytesSha256 || capturedHash!==doc.archiveSha256)
    throw Error('Observation archive mismatch');
  const markets=exact.assets.filter(a=>a.key===doc.assetKey),asset=markets[0];
  if(markets.length!==1 || asset.venue!==doc.venue || asset.market!==doc.market || asset.quote!==doc.quote ||
    requestUrl(asset,first,end)!==doc.sourceUrl)throw Error('Observation market mismatch');
  const raw=rawResponseBytes==null?null:Buffer.from(rawResponseBytes);
  if((raw?hash(raw):null)!==doc.rawSha256)throw Error('Observation response mismatch');
  const attempts=doc.attempts;
  if(!Array.isArray(attempts) || (doc.sourceUrl && !attempts.length) || attempts.length>2)throw Error('Invalid venue attempts');
  let previous=start;
  for(const attempt of attempts){
    const from=Date.parse(attempt.startedAt),to=Date.parse(attempt.completedAt);
    if(!Number.isFinite(from) || !Number.isFinite(to) || from<previous || to<from || to>observed)throw Error('Invalid retrieval clock');
    previous=to;
  }
  const last=attempts.at(-1);
  if((last?.httpStatus??null)!==doc.httpStatus || (last?.rawSha256??null)!==doc.rawSha256 ||
    (last?.transportError??null)!==doc.transportError)throw Error('Observation attempt mismatch');
  const computed=compare(doc,asset,raw,Date.parse(exact.updatedAt??exact.retrievedAt));
  for(const [key,value] of Object.entries(computed)){
    if(!isDeepStrictEqual(doc[key],value))throw Error('Venue comparison did not reproduce');
  }
  return observation;
}
async function readRecord(dir,id){
  const bytes=await readBlob(dir,'records',id);
  return {id,...JSON.parse(bytes)};
}
async function loadVerified(key,dir,id,scope,record=null){
  record??=await readRecord(dir,id);
  const [archive,response]=await Promise.all([readBlob(dir,'archives',record.archiveBytesSha256),
    record.rawSha256?readBlob(dir,'responses',record.rawSha256):null]);
  verifySourceObservation(record,response,archive,{...scope,assetKey:key,id});
  return {record,response,archive};
}
export async function readSourceObservation(key,{dir=forwardDirectory(),date,archiveSha256,before,id}={}){
  if(typeof key!=='string' || !key || (archiveSha256!==undefined && !isHash(archiveSha256)))throw Error('Invalid observation lookup');
  const until=cutoff(before);
  if(id!==undefined){
    if(!isHash(id))throw Error('Invalid observation id');
    let record;
    try{record=await readRecord(dir,id);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    return (await loadVerified(key,dir,id,{date,archiveSha256,before},record)).record;
  }
  date??=iso(Number.isFinite(until)?until:Date.now()).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || iso(Date.parse(date)).slice(0,10)!==date)
    throw Error('Invalid observation date');
  let files;
  try{files=await readdir(marketIndex(dir,key,date));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const candidates=files.map(f=>/^(\d{13})-([a-f0-9]{64})$/.exec(f)).filter(m=>m && Number(m[1])<=until)
    .sort((a,b)=>Number(b[1])-Number(a[1]) || a[2].localeCompare(b[2]));
  let latest=null;
  for(const [file,stamp,pin] of candidates){
    if(latest && Number(stamp)<Date.parse(latest.observedAt))break;
    if(await readFile(path.join(marketIndex(dir,key,date),file),'utf8')!==pin)throw Error('Invalid observation index');
    const record=await readRecord(dir,pin);
    if(record.assetKey!==key || Date.parse(record.observedAt)!==Number(stamp))throw Error('Invalid observation index scope');
    if(archiveSha256 && record.archiveSha256!==archiveSha256)continue;
    const verified=(await loadVerified(key,dir,pin,{date,archiveSha256,before},record)).record;
    // If simultaneous reads disagree, an ambiguous candle cannot authorize an entry.
    if(!latest || latest.status==='matched')latest=verified;
  }
  return latest;
}
export async function readSourceObservationEvidence(key,{dir=forwardDirectory(),id}={}){
  const {record:observation,response,archive}=await loadVerified(key,dir,id,{});
  const rawResponse=response?.toString('utf8')??null,archiveText=archive.toString('utf8');
  if((response && !response.equals(Buffer.from(rawResponse))) || !archive.equals(Buffer.from(archiveText)))
    throw Error('Observation payload is not lossless UTF-8; retrieve the binary artifact');
  return {observation,rawResponse,archiveText};
}
export async function readSourceObservationArtifact(key,{dir=forwardDirectory(),id,kind}={}){
  if(!['observation','response','archive'].includes(kind))throw Error('Unknown observation artifact');
  const {record,response,archive}=await loadVerified(key,dir,id,{});
  if(kind==='response')return response;
  if(kind==='archive')return archive;
  const {id:pin,...document}=record;
  return Buffer.from(JSON.stringify(document));
}
