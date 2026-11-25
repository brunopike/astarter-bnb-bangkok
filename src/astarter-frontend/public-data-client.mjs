// Public research reads only. Never imports the simulation, account or credit stores.
import {approvedTokenImageURL,registerTokenMetadata} from './brand-icons.mjs';
import {
 BLUESKY_DID, BLUESKY_HANDLE, BLUESKY_RKEY, NOSTR_HEX, DIRECT_SOCIAL_VALID_MS,
 RECENT_SOCIAL_PROVIDERS, RECENT_SOCIAL_SCOPE, SOCIAL_PLATFORMS, SOCIAL_POST_WINDOW_MS, SOCIAL_SYMBOLS,
 blueskyProfile, nostrPermalink, shortSocialKey
} from './public-social-scope.mjs';
export const PUBLIC_SCHEMA='AstarterPublicData.v1';
export const PUBLIC_PROJECTION='public-data-projection.v1';
export const PUBLIC_ASSETS=Object.freeze({bitcoin:'BTC',ethereum:'ETH',solana:'SOL'});
export const PUBLIC_CHAINS=Object.freeze({'1':'Ethereum','56':'BSC','8453':'Base','42161':'Arbitrum','137':'Polygon','10':'Optimism'});
export const PUBLIC_RESOURCES=Object.freeze({markets:'markets',assets:'assets',news:'news',social:'social',capabilities:'explorer/capabilities'});
const qualities=new Set(['fresh','partial','stale','unavailable']);
const decimal=/^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const signed=/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const text=(v,max=2000)=>typeof v==='string'&&v.length>0&&v.length<=max;
const time=v=>v===null||Number.isSafeInteger(v)&&v>=0;
const clock=v=>Number.isSafeInteger(v)&&v>=0;
const amount=(v,nullable=true,negative=false)=>v===null?nullable:typeof v==='string'&&v.length<=80&&(negative?signed:decimal).test(v);
const check=(condition)=>{if(!condition)throw new Error('DATA_RESPONSE_INVALID');};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

export function publicQuery(resource,input={}){
 if(!Object.hasOwn(PUBLIC_RESOURCES,resource))throw new Error('INVALID_QUERY');
 const params=input instanceof URLSearchParams?input:new URLSearchParams(Object.entries(input).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,Array.isArray(v)?v.join(','):String(v)]));
 const allowed=new Set(['selection_version',...(['markets','assets'].includes(resource)?['asset_ids']:resource==='social'?['limit','feed','symbol','platform']:resource==='news'?['limit']:['provider_id','chain_id'])]);
 for(const key of params.keys())if(!allowed.has(key)||params.getAll(key).length!==1)throw new Error('INVALID_QUERY');
 const integer=(key,fallback,min,max)=>{const s=params.get(key)??String(fallback);if(!/^(0|[1-9]\d*)$/.test(s)||Number(s)<min||Number(s)>max)throw new Error('INVALID_QUERY');return Number(s);};
 const out={selection_version:integer('selection_version',0,0,2147483647)};
 if(['markets','assets'].includes(resource)){
  const ids=(params.get('asset_ids')??Object.keys(PUBLIC_ASSETS).join(',')).split(',');
  if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!Object.hasOwn(PUBLIC_ASSETS,id)))throw new Error('INVALID_QUERY');
  out.asset_ids=ids.join(',');
 }else if(['news','social'].includes(resource)){
  out.limit=integer('limit',20,1,50);
  if(resource==='social'&&params.has('feed')){if(!['recent','featured'].includes(params.get('feed')))throw Error('INVALID_QUERY');out.feed=params.get('feed');}
  if(resource==='social')for(const [key,values] of [['symbol',SOCIAL_SYMBOLS],['platform',SOCIAL_PLATFORMS]]){
   if(!params.has(key))continue;
   const value=params.get(key);
   if(out.feed!=='recent'||!values.includes(value))throw Error('INVALID_QUERY');
   out[key]=value;
  }
 }
 else {if(params.get('provider_id')!=='etherscan')throw new Error('INVALID_QUERY');out.provider_id='etherscan';if(params.has('chain_id')){const chain=params.get('chain_id');if(!Object.hasOwn(PUBLIC_CHAINS,chain))throw new Error('INVALID_QUERY');out.chain_id=chain;}}
 return out;
}
export function publicDataURL(resource,input={}){const query=publicQuery(resource,input);return ['news','social'].includes(resource)?'/api/market-hub?'+new URLSearchParams({resource,...query}):'/api/v1/data/'+PUBLIC_RESOURCES[resource]+'?'+new URLSearchParams(query);}
export const safePublicURL=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}};
const lunarPlatforms={X:['x.com','twitter.com'],Reddit:['reddit.com','redd.it'],YouTube:['youtube.com','youtu.be'],Instagram:['instagram.com'],TikTok:['tiktok.com'],Facebook:['facebook.com','fb.watch']};
const creatorNetworks={X:'twitter',Reddit:'reddit',YouTube:'youtube',Instagram:'instagram',TikTok:'tiktok',Facebook:'facebook'};
const lunarCount=value=>value===null||Number.isSafeInteger(value)&&value>=0;
const observed=value=>Number.isSafeInteger(value)&&value>0&&value<=8640000000000000;
const assetSymbols=Object.values(PUBLIC_ASSETS);
const symbolList=value=>Array.isArray(value)&&value.length<=3&&new Set(value).size===value.length&&value.every(symbol=>assetSymbols.includes(symbol));
const rankedCount=(value,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const recentSymbolList=value=>Array.isArray(value)&&value.length<=SOCIAL_SYMBOLS.length&&
 new Set(value).size===value.length&&value.every(symbol=>SOCIAL_SYMBOLS.includes(symbol));
function platformURL(value,platform){
 if(!text(value,2048)||!safePublicURL(value))return false;
 const url=new URL(value);return !url.port&&lunarPlatforms[platform].some(host=>url.hostname===host||url.hostname.endsWith('.'+host));
}
function validateLunarCoverage(coverage,requestedAt){
 const {topics,errors,observed_at_ms:at}=coverage;
 check(observed(at)&&at<=requestedAt+1000&&Array.isArray(topics)&&topics.length<=3&&new Set(topics.map(item=>item?.symbol)).size===topics.length);
 for(const topic of topics){
  check(topic&&Object.hasOwn(PUBLIC_ASSETS,topic.topic)&&PUBLIC_ASSETS[topic.topic]===topic.symbol&&(topic.asOf===null||observed(topic.asOf)&&topic.asOf<=at+60000));
  check([topic.posts24h,topic.contributors24h,topic.interactions24h].every(lunarCount));
  const scores=topic.sentimentByNetwork;
  check(scores&&typeof scores==='object'&&!Array.isArray(scores)&&Object.entries(scores).every(([network,score])=>(network==='News'||Object.hasOwn(lunarPlatforms,network))&&Number.isFinite(score)&&score>=0&&score<=100));
 }
 const curated=coverage.scope==='LUNARCRUSH_KOL_TOPICS',recent=coverage.feed==='recent';
 if(recent)check(!curated&&coverage.discovery?.category==='cryptocurrencies'&&['OK','UNAVAILABLE'].includes(coverage.discovery.status));
 check(Array.isArray(errors)&&errors.length<=(curated?9:recent?7:6)&&errors.every(error=>error&&text(error.code,80)&&(recent&&error.resource==='category-posts'?error.symbol==='CRYPTO':assetSymbols.includes(error.symbol)&&(curated?['topic','posts','creators']:['topic','posts']).includes(error.resource))));
 if(curated){
  const policy=coverage.curation;
  check(policy&&policy.minFollowers===50000&&policy.maxTopicRank===100&&policy.minCreatorInteractions24h===1000&&policy.minDistinctPosts===2&&policy.maxPostsPerAuthor===1);
  check(symbolList(policy.checkedTopics)&&symbolList(policy.failedTopics)&&policy.checkedTopics.length+policy.failedTopics.length===3&&policy.checkedTopics.every(symbol=>!policy.failedTopics.includes(symbol)));
  check(rankedCount(policy.rankedCreators,0)&&rankedCount(policy.qualifiedCreators,0,policy.rankedCreators));
 }
}

function validateRecentCoverage(body){
 const {coverage,sources,requested_at_ms:requested}=body;
 const at=coverage.observed_at_ms;
 check(coverage.feed==='recent'&&body.mode==='live_readonly'&&coverage.curation===undefined&&
  observed(at)&&at===body.as_of_ms&&at<=requested+1000);
 check(sources.length===RECENT_SOCIAL_PROVIDERS.length&&new Set(sources.map(s=>s?.provider_id)).size===sources.length&&
  sources.every(source=>source&&RECENT_SOCIAL_PROVIDERS.includes(source.provider_id)&&
   (source.status==='OK'?observed(source.last_success_at_ms)&&source.last_success_at_ms<=at:
    source.status==='UNAVAILABLE'&&source.last_success_at_ms===null)));
 check(sources.some(source=>source.status==='OK'&&source.last_success_at_ms===at));
 const lunar=sources.find(source=>source.provider_id==='lunarcrush-v4');
 const bluesky=sources.find(source=>source.provider_id==='bluesky-latest-v1');
 if(lunar.status==='OK'){
  check(coverage.lunar&&coverage.lunar.observed_at_ms===lunar.last_success_at_ms);
  validateLunarCoverage({...coverage.lunar,feed:'recent'},requested);
 }else check(coverage.lunar===null);
 check(recentSymbolList(coverage.bluesky_failed_symbols)&&
   (bluesky.status==='OK'||coverage.bluesky_failed_symbols.length===0));
}

function validateDirectSocialPost(item,body){
 const d=item.data,source=body.sources.find(source=>source.status==='OK'&&source.provider_id===item.provider_id);
 const bluesky=item.provider_id==='bluesky-latest-v1';
 check(source&&(bluesky||item.provider_id==='nostr-relay-v1')&&d.platform===(bluesky?'Bluesky':'Nostr')&&
  d.metric_kind==='SOCIAL_ORIGINAL_POST'&&d.kol===undefined&&text(d.text,644)&&Array.from(d.text).length<=321&&
  recentSymbolList(d.symbols)&&d.symbols.length>0);
 const at=d.observed_at_ms,published=d.published_at_ms,a=d.author;
 check(at===source.last_success_at_ms&&observed(published)&&published<=at&&published>at-SOCIAL_POST_WINDOW_MS&&
  at===item.received_at_ms&&at===item.available_at_ms&&published===item.event_time_ms&&
  item.valid_until_ms===Math.min(published+SOCIAL_POST_WINDOW_MS,at+DIRECT_SOCIAL_VALID_MS));
 check(a&&a.bot===null&&text(d.post_id,64)&&text(d.creator_id,190));
 const id=item.provider_id+':'+d.creator_id+':'+d.post_id;
 check(item.record_id===id&&item.subject_id===id);
 if(bluesky){
  const profile=blueskyProfile(d.creator_id);
  check(BLUESKY_DID.test(d.creator_id)&&BLUESKY_RKEY.test(d.post_id)&&a.url===profile&&
   d.url===profile+'/post/'+d.post_id&&text(a.acct,253)&&BLUESKY_HANDLE.test(a.acct)&&a.acct!=='handle.invalid'&&
   text(a.display_name,300)&&[d.likes,d.reposts,d.replies].every(lunarCount));
 }else{
  check(NOSTR_HEX.test(d.creator_id)&&NOSTR_HEX.test(d.post_id)&&a.url===null&&a.display_name===null&&
   a.acct===shortSocialKey(d.creator_id)&&d.url===nostrPermalink(d.post_id)&&[d.likes,d.reposts,d.replies].every(value=>value===null));
 }
}

export function validatePublicEnvelope(body,resource,input={}){
 const q=publicQuery(resource,input),ids=q.asset_ids?.split(',');
 check(body&&body.schema_version===PUBLIC_SCHEMA&&body.tenant_scope==='PUBLIC'&&body.projection_version===PUBLIC_PROJECTION);
 check(text(body.request_id,200)&&body.selection_version===q.selection_version&&['live_readonly','offline_fixture'].includes(body.mode));
 check(body.real_trading_connected===false&&body.execution_binding==='NONE'&&qualities.has(body.quality)&&time(body.as_of_ms)&&time(body.requested_at_ms));
 check(body.coverage&&typeof body.coverage==='object'&&!Array.isArray(body.coverage)&&Array.isArray(body.missing_capabilities)&&Array.isArray(body.sources)&&Array.isArray(body.items));
 check(body.items.length<=200&&body.sources.length<=50&&body.missing_capabilities.every(v=>text(v,200)));
 if(['news','social'].includes(resource))check(body.items.length<=q.limit);
 const curated=resource==='social'&&body.coverage.scope==='LUNARCRUSH_KOL_TOPICS',lunar=curated||resource==='social'&&body.coverage.scope==='LUNARCRUSH_TOPICS';
 const recent=resource==='social'&&body.coverage.feed==='recent';
 const merged=resource==='social'&&body.coverage.scope===RECENT_SOCIAL_SCOPE;
 if(resource==='social'){
  if(q.feed==='recent')check(recent&&(merged||body.coverage.scope==='LUNARCRUSH_TOPICS'&&!q.symbol&&!q.platform));
  if(q.feed==='featured')check(curated);
  check(observed(body.requested_at_ms));
  if(merged){check(q.feed==='recent');validateRecentCoverage(body);}
  else{
   check((lunar||body.coverage.scope==='SOCIAL_TAG_SAMPLES')&&body.sources.some(source=>source?.provider_id===(lunar?'lunarcrush-v4':'mastodon-tag-v1')));
   if(lunar)validateLunarCoverage(body.coverage,body.requested_at_ms);
  }
 }
 for(const s of body.sources)check(text(s.provider_id,200)&&text(s.status,80)&&time(s.last_success_at_ms)&&(s.reason_code===null||text(s.reason_code,100))&&(s.retry_after_seconds===null||Number.isFinite(s.retry_after_seconds)&&s.retry_after_seconds>=0));
 const seen=new Set(),subjects=new Set(),authors=new Set();
 for(const item of body.items){
  check(item&&text(item.record_id,300)&&!seen.has(item.record_id)&&text(item.subject_id,300)&&text(item.provider_id,200)&&qualities.has(item.quality));seen.add(item.record_id);
  // Only the source event time may be unknown; receipt, availability and expiry always come with a fact.
  check(time(item.event_time_ms));for(const key of ['received_at_ms','available_at_ms','valid_until_ms'])check(clock(item[key]));
  check(item.venue_or_chain===null||text(item.venue_or_chain,200));check(item.source_revision===null||text(item.source_revision,300));
  const d=item.data;check(d&&typeof d==='object'&&!Array.isArray(d));
  if(ids){check(!subjects.has(item.subject_id));subjects.add(item.subject_id);}
  if(resource==='markets'){
   check(ids.includes(item.subject_id)&&d.metric_kind==='SPOT_24H_STATISTICS');
   const i=d.instrument;check(i&&i.venue==='BINANCE'&&i.market_kind==='SPOT'&&i.base_asset===PUBLIC_ASSETS[item.subject_id]&&i.quote_asset==='USDT'&&i.symbol===i.base_asset+'USDT'&&item.venue_or_chain==='BINANCE:SPOT');
   check(amount(d.last_price,false)&&Number(d.last_price)>0&&amount(d.base_volume,false)&&amount(d.quote_volume,false)&&amount(d.price_change_pct,true,true));
   check(Number.isSafeInteger(d.window_open_at_ms)&&Number.isSafeInteger(d.window_close_at_ms)&&d.window_open_at_ms>=0&&d.window_close_at_ms>=d.window_open_at_ms);
  }else if(resource==='assets'){
   check(ids.includes(item.subject_id)&&d.asset_id===item.subject_id&&d.symbol===PUBLIC_ASSETS[item.subject_id]&&d.quote_currency==='USD'&&text(d.name,200));
   check(amount(d.market_cap)&&amount(d.total_volume)&&Array.isArray(d.contracts)&&d.contracts.length<=100);
   if(d.image_url!==undefined)check(d.image_url===null||approvedTokenImageURL(d.image_url)!==null);
   for(const c of d.contracts)check(text(c.chain_id,80)&&text(c.address,200));
  }else if(resource==='news'){
   check(text(d.news_id,300)&&text(d.title,2000)&&typeof d.summary==='string'&&d.summary.length<=30000&&typeof d.url==='string'&&d.url.length<=3000&&Number.isSafeInteger(d.published_at_ms)&&d.published_at_ms>=0);
   check(Array.isArray(d.asset_ids)&&d.asset_ids.every(id=>Object.hasOwn(PUBLIC_ASSETS,id)));
   if(d.symbols!==undefined)check(Array.isArray(d.symbols)&&d.symbols.length<=8&&new Set(d.symbols).size===d.symbols.length&&d.symbols.every(s=>['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y'].includes(s)));
  }else if(lunar||merged&&item.provider_id==='lunarcrush-v4'){
   check(item.provider_id==='lunarcrush-v4'&&d.metric_kind==='LUNARCRUSH_POST'&&text(d.post_id,300)&&Object.hasOwn(lunarPlatforms,d.platform));
   check(text(d.text,1200)&&Array.from(d.text).length<=600&&platformURL(d.url,d.platform));
   check(d.author&&(d.author.acct===null||text(d.author.acct,200))&&(d.author.display_name===null||text(d.author.display_name,300))&&d.author.url===null&&d.author.bot===null);
   check((merged?recentSymbolList(d.symbols):symbolList(d.symbols))&&(recent||d.symbols.length>0)&&lunarCount(d.interactions_24h));
   const lunarAt=merged?body.coverage.lunar?.observed_at_ms:body.coverage.observed_at_ms;
   check(observed(d.published_at_ms)&&observed(lunarAt)&&d.observed_at_ms===lunarAt&&d.published_at_ms<=d.observed_at_ms+60000&&d.published_at_ms===item.event_time_ms&&d.observed_at_ms===item.received_at_ms&&d.observed_at_ms===item.available_at_ms&&item.valid_until_ms===d.observed_at_ms+3600000);
   if(recent)check(d.kol===undefined&&typeof d.creator_id==='string'&&d.creator_id.startsWith(creatorNetworks[d.platform]+'::')&&/^[a-z]+::[A-Za-z0-9_-]{1,100}$/.test(d.creator_id)&&d.published_at_ms>=d.observed_at_ms-86400000-8000&&rankedCount(d.interactions_24h,0));
   if(curated){
    const kol=d.kol,policy=body.coverage.curation;
    check(kol&&text(kol.creatorId,300)&&rankedCount(kol.followers,policy.minFollowers)&&rankedCount(kol.topicRank,1,policy.maxTopicRank)&&rankedCount(kol.creatorInteractions24h,policy.minCreatorInteractions24h)&&rankedCount(kol.qualifyingPostCount,policy.minDistinctPosts));
    check((d.author.acct||d.author.display_name)&&d.symbols.includes(kol.evidenceSymbol)&&policy.checkedTopics.includes(kol.evidenceSymbol)&&(kol.profileUrl===null||platformURL(kol.profileUrl,d.platform)));
    check(kol.creatorId.startsWith(creatorNetworks[d.platform]+'::')&&/^[a-z]+::[A-Za-z0-9_-]{1,100}$/.test(kol.creatorId)&&!authors.has(kol.creatorId));authors.add(kol.creatorId);
    check(d.published_at_ms>=d.observed_at_ms-86400000-8000&&d.interactions_24h>0);
   }
  }else if(merged){
   validateDirectSocialPost(item,body);
  }else if(resource==='social'){
   check(item.provider_id==='mastodon-tag-v1'&&d.observed_at_ms<=body.requested_at_ms+1000);
   check(d.metric_kind==='PUBLIC_SOCIAL_POST'&&d.platform==='Mastodon'&&d.instance==='mastodon.social'&&text(d.post_id,300)&&safePublicURL(d.url)!==null&&text(d.text,600)&&typeof d.truncated==='boolean');
   check(d.author&&text(d.author.acct,200)&&typeof d.author.display_name==='string'&&d.author.display_name.length<=300&&safePublicURL(d.author.url)!==null&&[true,false,null].includes(d.author.bot));
   check(Number.isSafeInteger(d.published_at_ms)&&d.published_at_ms>0&&time(d.edited_at_ms)&&Number.isSafeInteger(d.observed_at_ms)&&d.observed_at_ms>0&&d.published_at_ms<=d.observed_at_ms+60000&&(d.edited_at_ms===null||d.edited_at_ms>=d.published_at_ms&&d.edited_at_ms<=d.observed_at_ms+60000));
   check(d.observed_at_ms===item.received_at_ms&&d.published_at_ms===item.event_time_ms&&item.available_at_ms===d.observed_at_ms&&item.valid_until_ms===Math.min(d.published_at_ms+86400000,d.observed_at_ms+300000));
   check(Array.isArray(d.symbols)&&d.symbols.length<=3&&new Set(d.symbols).size===d.symbols.length&&d.symbols.every(symbol=>['BTC','ETH','SOL'].includes(symbol))&&['likes','reposts','replies'].every(key=>Number.isSafeInteger(d[key])&&d[key]>=0));
  }else{
   check(Object.hasOwn(PUBLIC_CHAINS,d.chain_id)&&(!q.chain_id||d.chain_id===q.chain_id)&&['proxy.block_number','contract.abi'].includes(d.capability_id));
   check(['VERIFIED','UNTESTED'].includes(d.verification_state)&&text(d.status,80)&&time(d.verified_at_ms)&&(d.reason_code===null||text(d.reason_code,100)));
   if(d.block_height!=null)check(Number.isSafeInteger(d.block_height)&&d.block_height>0&&d.capability_id==='proxy.block_number'&&d.verification_state==='VERIFIED'&&['etherscan-v2','publicnode'].includes(d.block_provider)&&(d.block_provider!=='etherscan-v2'||d.status==='OK'));
   if(d.abi_function_count!=null)check(Number.isSafeInteger(d.abi_function_count)&&d.abi_function_count>0&&d.abi_function_count<10000&&d.capability_id==='contract.abi'&&d.status==='OK'&&d.verification_state==='VERIFIED');
  }
 }
 if(ids){
  if(Array.isArray(body.coverage.requested_subjects))check(body.coverage.requested_subjects.length===ids.length&&body.coverage.requested_subjects.every(id=>ids.includes(id)));
  if(Array.isArray(body.coverage.returned_subjects))check(body.coverage.returned_subjects.length===subjects.size&&body.coverage.returned_subjects.every(id=>subjects.has(id)));
 }
 // Same evidence rule as the service: unavailable carries no snapshot or time, every other quality carries its time,
 // and only a news or social read that succeeded may be empty (the social checks above pin its scope, provider and request time).
 check(body.quality==='unavailable'?body.items.length===0&&body.as_of_ms===null:body.as_of_ms!==null);
 if(!body.items.length&&body.quality!=='unavailable')check(resource==='social'||resource==='news'&&body.coverage.scope==='NEWS_FEED'&&body.sources.some(s=>s.last_success_at_ms!==null)&&(body.quality!=='fresh'||body.sources.some(s=>s.status==='OK')));
 if(body.items.length)check(body.as_of_ms!==null);
 if(merged)check(body.items.every((item,index)=>item.event_time_ms>body.requested_at_ms-SOCIAL_POST_WINDOW_MS&&
  (!index||body.items[index-1].event_time_ms>=item.event_time_ms)&&
  (!q.symbol||item.data.symbols.includes(q.symbol))&&(!q.platform||item.data.platform===q.platform)));
 if(curated)check(body.items.length<=body.coverage.curation.qualifiedCreators);
 return freeze(body);
}

// Expiry is evaluated against the fact's validity, never against the refresh time.
export function currentPublicEnvelope(body,now=Date.now(),readFailed=false){
 if(!body)return null;
 const items=body.items.map(item=>({...item,quality:readFailed||item.valid_until_ms!==null&&(now>item.valid_until_ms||
  ['LUNARCRUSH_POST','SOCIAL_ORIGINAL_POST'].includes(item.data?.metric_kind)&&now===item.valid_until_ms)?'stale':item.quality}));
 const stale=items.filter(item=>item.quality==='stale').length;
 const emptyFeed=items.length===0&&['NEWS_FEED','SOCIAL_TAG_SAMPLES',RECENT_SOCIAL_SCOPE].includes(body.coverage.scope)&&body.as_of_ms!==null&&body.quality!=='unavailable';
 const emptyValid=body.coverage.scope===RECENT_SOCIAL_SCOPE?DIRECT_SOCIAL_VALID_MS:body.coverage.scope==='SOCIAL_TAG_SAMPLES'?300000:60000;
 const emptyFeedStale=emptyFeed&&(readFailed||now-body.as_of_ms>emptyValid);
 const lunarStale=['LUNARCRUSH_TOPICS','LUNARCRUSH_KOL_TOPICS'].includes(body.coverage.scope)&&body.quality!=='unavailable'&&(readFailed||now>=body.coverage.observed_at_ms+3600000);
 const quality=lunarStale||emptyFeedStale||(readFailed&&items.length>0)||(stale>0&&stale===items.length)?'stale':stale&&body.quality==='fresh'?'partial':body.quality;
 return {...body,items,quality};
}

export function publicRetryDelay(value,now=Date.now()){
 if(typeof value!=='string'||!value.trim())return null;
 const text=value.trim(),ms=/^\d+$/.test(text)?Number(text)*1000:Date.parse(text)-now;
 return Number.isSafeInteger(ms)&&ms>=0?ms:null;
}

export function createPublicDataClient({fetchImpl=globalThis.fetch,onChange=()=>{},timeoutMs=8000,now=Date.now}={}){
 const slots=new Map();let generation=0;
 // A snapshot kept after a failed read stays stale while the retry is pending, until a read succeeds again.
 const read=resource=>{const s=slots.get(resource);return s?{...s,retryIn:Math.max(0,Math.ceil((s.retryAt-now())/1000)),snapshot:currentPublicEnvelope(s.snapshot,now(),!!s.error||s.failures>0)}:{pending:false,snapshot:null,error:null,key:null,retryIn:0};};
 const cancel=resource=>{const s=slots.get(resource);if(s){s.controller?.abort();slots.delete(resource);}};
 function load(resource,input={}){
  const query=publicQuery(resource,input),key=JSON.stringify(Object.fromEntries(Object.entries(query).filter(([k])=>k!=='selection_version'))),previous=slots.get(resource);
  if(previous?.pending&&previous.key===key&&previous.query.selection_version===query.selection_version)return previous.promise;
  if(previous?.key===key&&previous.retryAt>now())return Promise.resolve(read(resource));
  previous?.controller?.abort();
  const controller=new AbortController(),id=++generation;
  const s={key,query,id,controller,pending:true,error:null,snapshot:previous?.key===key?previous.snapshot:null,lastAttempt:now(),retryAt:0,failures:previous?.key===key?previous.failures:0,promise:null};slots.set(resource,s);
  s.promise=(async()=>{
   let timedOut=false,retryDelay=0;const timer=setTimeout(()=>{timedOut=true;controller.abort();},resource==='capabilities'?Math.max(timeoutMs,12000):timeoutMs);
   try{
    const response=await fetchImpl(publicDataURL(resource,query),{method:'GET',headers:{Accept:'application/json'},credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
    retryDelay=publicRetryDelay(response.headers.get('Retry-After'),now())||0;
    if(!response.ok){try{void response.body?.cancel().catch(()=>{});}catch{}throw new Error(response.status===503||response.status===429?'DATA_SERVICE_UNAVAILABLE':response.status===400?'INVALID_QUERY':response.status===403?'DATA_ACCESS_DENIED':'DATA_REQUEST_FAILED');}
    const raw=await response.text();if(controller.signal.aborted)throw new Error('DATA_TIMEOUT');if(raw.length>1000000)throw new Error('DATA_RESPONSE_INVALID');
    let body;try{body=JSON.parse(raw);}catch{throw new Error('DATA_RESPONSE_INVALID');}
    const snapshot=validatePublicEnvelope(body,resource,query);
    if(slots.get(resource)?.id===id){s.snapshot=snapshot;s.error=null;s.failures=0;s.retryAt=now()+Math.max(retryDelay,...snapshot.sources.map(source=>(source.retry_after_seconds||0)*1000));if(resource==='assets'&&snapshot.mode==='live_readonly')registerTokenMetadata(snapshot.items,{persist:true});}
   }catch(error){
    if(slots.get(resource)?.id!==id)return null;
    if(controller.signal.aborted&&!timedOut)return null;
    s.error=timedOut?'DATA_TIMEOUT':['DATA_SERVICE_UNAVAILABLE','DATA_ACCESS_DENIED','INVALID_QUERY','DATA_REQUEST_FAILED','DATA_RESPONSE_INVALID'].includes(error?.message)?error.message:'DATA_SERVICE_UNAVAILABLE';
    s.failures++;s.retryAt=now()+Math.max(retryDelay,Math.min(30000,2000*2**Math.min(s.failures-1,4)));
   }finally{
    clearTimeout(timer);
    if(slots.get(resource)?.id===id){s.pending=false;s.controller=null;onChange(resource);}
   }
   return read(resource);
  })();return s.promise;
 }
 return {load,read,cancel,clear(){for(const key of slots.keys())cancel(key);}};
}
