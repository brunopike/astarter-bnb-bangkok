import {getCache} from '@vercel/functions';
import {createMarketHubRelay} from './market-hub-relay.mjs';
import {PUBLIC_SCHEMA,PUBLIC_PROJECTION,publicQuery,validatePublicEnvelope} from './public-data-client.mjs';
import {fetchBlockBeats} from './public-blockbeats.mjs';
import {fetchLunarCrush} from './public-lunarcrush.mjs';
import {PUBLIC_NEWS_SOURCE,parsePublicNews,projectPublicNews} from './public-news.mjs';

const hour=3600000;
const publishers=['blockbeats-news-v1','coindesk-rss-v1'];
const source=(id,ok,at)=>({provider_id:id,status:ok?'OK':'UNAVAILABLE',last_success_at_ms:ok?at:null,reason_code:ok?null:'SOURCE_UNAVAILABLE',retry_after_seconds:null});
const base=(kind,query,at)=>({schema_version:PUBLIC_SCHEMA,tenant_scope:'PUBLIC',projection_version:PUBLIC_PROJECTION,request_id:kind+':'+at,selection_version:query.selection_version,mode:'live_readonly',real_trading_connected:false,execution_binding:'NONE',requested_at_ms:at});

async function coinDesk(fetchImpl,signal){
 const response=await fetchImpl(PUBLIC_NEWS_SOURCE.url,{headers:PUBLIC_NEWS_SOURCE.headers,credentials:'omit',redirect:'error',signal});
 if(!response.ok){await response.body?.cancel();throw Error('PUBLISHER_UNAVAILABLE');}
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>PUBLIC_NEWS_SOURCE.maxBytes)throw Error('INVALID_NEWS');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 return parsePublicNews(Buffer.concat(chunks).toString('utf8'),Date.now()).items;
}

function projectNews(parts,query,at){
 const sources=parts.map((part,index)=>source(publishers[index],part.status==='fulfilled',part.value?.at));
 const items=parts.flatMap((part,index)=>part.status==='fulfilled'?projectPublicNews({items:part.value.data,receivedAt:part.value.at},query,at,publishers[index]).items:[]).sort((left,right)=>right.event_time_ms-left.event_time_ms).slice(0,query.limit);
 const partial=sources.some(row=>row.status!=='OK')||items.some(row=>row.quality==='stale');
 return {...base('news',query,at),quality:items.length&&items.every(row=>row.quality==='stale')?'stale':partial?'partial':'fresh',as_of_ms:items[0]?.event_time_ms??Math.max(...sources.map(row=>row.last_success_at_ms||0)),coverage:{scope:'NEWS_FEED',content:'headline links',asset_matching:'headline keywords'},missing_capabilities:['news.ai_analysis'],sources,items};
}

function projectSocial(snapshot,query,at){
 const observed=snapshot.observedAt;
 const items=snapshot.posts.slice(0,query.limit).map(post=>{
  const id=post.network+':'+post.id,{creatorId,followers,profileUrl,topicRank,creatorInteractions24h,qualifyingPostCount,evidenceSymbol}=post;
  const kol={creatorId,followers,profileUrl,topicRank,creatorInteractions24h,qualifyingPostCount,evidenceSymbol};
  return {record_id:'lunarcrush:'+id,subject_id:id,provider_id:'lunarcrush-v4',quality:at>=observed+hour?'stale':'fresh',event_time_ms:post.publishedAt,received_at_ms:observed,available_at_ms:observed,valid_until_ms:observed+hour,source_revision:null,venue_or_chain:null,data:{metric_kind:'LUNARCRUSH_POST',post_id:post.id,platform:post.network,text:post.title,url:post.url,author:{acct:post.author,display_name:post.author,url:null,bot:null},symbols:post.symbols,published_at_ms:post.publishedAt,observed_at_ms:observed,interactions_24h:post.interactions24h,kol}};
 });
 return {...base('social',query,at),as_of_ms:observed,quality:at>=observed+hour?'stale':snapshot.errors.length?'partial':'fresh',coverage:{scope:'LUNARCRUSH_KOL_TOPICS',observed_at_ms:observed,topics:snapshot.topics,errors:snapshot.errors,curation:snapshot.curation},missing_capabilities:['social.individual_engagement_breakdown'],sources:[source('lunarcrush-v4',true,observed)],items};
}

export function createLicensedFeeds({fetchImpl=globalThis.fetch,env=process.env,now=Date.now,cache=null,blockbeats=fetchBlockBeats,lunarcrush=fetchLunarCrush,coindesk=coinDesk}={}){
 const market=createMarketHubRelay({fetchImpl,now,cache});
 const slots=new Map();
 async function shared(id,ttl,load){
  const current=slots.get(id);
  if(current?.until>now())return current.promise;
  const slot={until:Infinity};slots.set(id,slot);
  slot.promise=(async()=>{
   try{
    let value=await cache?.get(id).catch(()=>null);
    if(!value||!Number.isSafeInteger(value.at)||value.at>now()+1000||value.at+ttl<=now()){
     const data=await load(AbortSignal.timeout(7000));value={at:now(),data};
     await cache?.set(id,value,{ttl:ttl/1000}).catch(()=>{});
    }
    slot.until=value.at+ttl;return value;
   }catch(error){slot.until=now()+60000;throw error;}
  })();return slot.promise;
 }
 return async function handle(req,res){
  const url=new URL(req.url,'http://localhost'),kind=url.searchParams.get('resource');
  if(url.pathname!=='/api/market-hub'||!['news','social'].includes(kind))return market(req,res);
  const send=(status,payload,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(payload));return true;};
  if(req.method!=='GET')return send(405,{error:'METHOD_NOT_ALLOWED'},{Allow:'GET'});
  if(url.searchParams.getAll('resource').length!==1)return send(400,{error:'UNKNOWN_RESOURCE'});
  url.searchParams.delete('resource');let query;try{query=publicQuery(kind,url.searchParams);}catch{return send(400,{error:'UNKNOWN_RESOURCE'});}
  try{
   if(kind==='social'){const value=await shared('lunarcrush-kol-v2',hour,signal=>lunarcrush(fetchImpl,env.LUNARCRUSH_API_KEY,signal));return send(200,validatePublicEnvelope(projectSocial(value.data,query,now()),kind,query));}
   const parts=await Promise.allSettled([shared('blockbeats-1',300000,signal=>blockbeats(fetchImpl,env.BLOCKBEATS_API_KEY,signal)),shared('coindesk-1',300000,signal=>coindesk(fetchImpl,signal))]);
   if(parts.every(part=>part.status==='rejected'))throw Error('PUBLIC_SOURCE_UNAVAILABLE');
   return send(200,projectNews(parts,query,now()));
  }catch{return send(503,{error:'PUBLIC_SOURCE_UNAVAILABLE'},{'Retry-After':'60'});}
 };
}

export const handleMarketHub=createLicensedFeeds({cache:process.env.VERCEL==='1'?getCache({namespace:'lenswave-public-feeds-v1'}):null});
