const assets={bitcoin:'BTC',ethereum:'ETH',solana:'SOL'};
const networks={
 tweet:['X','x.com','twitter.com'], 'reddit-post':['Reddit','reddit.com','redd.it'],
 'youtube-video':['YouTube','youtube.com','youtu.be'], 'instagram-post':['Instagram','instagram.com'],
 'tiktok-video':['TikTok','tiktok.com'], 'facebook-post':['Facebook','facebook.com','fb.watch']
};
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const string=(value,limit)=>typeof value==='string'&&value.trim()&&value.length<=limit?value.trim():null;
const invalid=()=>{throw Error('INVALID_DATA');};
const timestamp=(seconds,now)=>Number.isSafeInteger(seconds)&&seconds>0&&seconds<=Math.floor(now/1000)+60?seconds*1000:null;
const providerCodes=new Set(['AUTH_REQUIRED','FORBIDDEN','RATE_LIMIT','UNAVAILABLE','INVALID_DATA','TIMEOUT']);
const kolRules={minFollowers:50000,maxTopicRank:100,minCreatorInteractions24h:1000,minDistinctPosts:2,maxPostsPerAuthor:1};
const distributionAccounts={
 'twitter::1039833297751302144':'https://whale-alert.io/alerts.html',
 'twitter::1852674305517342720':'https://docs.aixbt.tech/legal/terms-and-conditions',
 'twitter::951329744804392960':'https://solana.com/community',
 'twitter::2207129125':'https://cointelegraph.com/about',
 'twitter::111533746':'https://wublock.substack.com/about'
};
const promotion=/(?:^|\s)#(?:ad|sponsored)\b|\b(?:sponsored (?:post|content|by)|paid (?:promotion|partnership)|promo code|affiliate partner|register now and (?:get|earn)|use code .{1,20} (?:for|to get))\b|限时返现|返佣码|注册立领|扫码领币/iu;
const transferAlert=/^[\p{P}\p{S}\s]*(?:whale alert[\p{P}\s]*)?[\d,.]+\s*[#$]?(?:BTC|WBTC|ETH|WETH|SOL|USDC|USDT)\b[^\n!?]{0,110}\b(?:transferred|sent|moved) from\s+[^\n!?]{1,80}\s+to\s+[^\n.!?]{1,80}[.!\s]*$/iu;
const textKey=title=>title.normalize('NFKC').toLowerCase().replace(/https?:\/\/\S+/gu,' ').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const spam=/\b(?:giveaway|referral (?:link|code)|affiliate (?:link|code)|use (?:my|our) (?:code|link)|sign up (?:with|using)|claim (?:your|free) (?:airdrop|reward)|join (?:my|our) (?:vip|signals? group)|retweet to (?:win|enter)|guaranteed returns?|deposit bonus)\b|邀请码|返佣链接|转发抽奖|关注.{0,8}抽奖|入群领|领取空投|加群返利/iu;
const networkIds={X:'twitter',YouTube:'youtube',Reddit:'reddit',TikTok:'tiktok',Instagram:'instagram',Facebook:'facebook'};
const namedTopic={bitcoin:/\bbitcoin\b|\bBTC\b|比特[币幣]|ビットコイン|비트코인|биткоин/iu,ethereum:/\bethereum\b|\bether\b|\bETH\b|以太[坊幣币]|イーサリアム|이더리움|эфириум/iu,solana:/\bsolana\b|索拉[娜纳納]|ソラナ|솔라나/iu};
const subjectMatter=/\b(?:liquidity|inflows?|outflows?|reserves?|issuance|staking|staked|validators?|upgrades?|protocol|etfs?|filings?|regulat\w+|treasur\w+|spot volume|open interest|funding rate|liquidat\w+|transferr?\w*|exploit\w*|hacks?|on[- ]chain|settlement|throughput|transactions?|fees?|rollups?|collateral|support level|resistance|volatility|integrat\w+|partnership|mainnet|testnet|deployed|inflation|hashrate|mining|supply|drawdown|basis points|custody)\b|[$€£]\s?[\d,.]+[kmb]?\b|\d(?:[\d,.]*)\s?(?:%|bps\b|usd\b|usdt\b)|流动性|资金流|成交量|锁仓|质押|链上|合约持仓|清算|升级|漏洞|监管|转账|主网|测试网|通胀/iu;

async function readJSON(response,limit){
 if(!response.ok){const codes={401:'AUTH_REQUIRED',402:'FORBIDDEN',403:'FORBIDDEN',429:'RATE_LIMIT'};await response.body?.cancel();throw Error(codes[response.status]||'UNAVAILABLE');}
 if(!/^application\/json\b/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>limit||!response.body){await response.body?.cancel();invalid();}
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();invalid();}text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode());}finally{reader.releaseLock();}
}

function topicRow(data,topic,asOf){
 if(!data||data.topic!==topic)invalid();
 const posts24h=count(data.num_posts),contributors24h=count(data.num_contributors),interactions24h=count(data.interactions_24h),sentimentByNetwork={};
 for(const [type,value] of Object.entries(data.types_sentiment||{})){
  const name=type==='news'?'News':Object.hasOwn(networks,type)?networks[type][0]:null;
  if(name&&Number.isFinite(value)&&value>=0&&value<=100)sentimentByNetwork[name]=value;
 }
 if([posts24h,contributors24h,interactions24h].every(value=>value===null)&&!Object.keys(sentimentByNetwork).length)invalid();
 return {symbol:assets[topic],topic,asOf,posts24h,contributors24h,interactions24h,sentimentByNetwork};
}

function postRows(rows,topic,now){
 if(!Array.isArray(rows)||rows.length>5000)invalid();const posts=[];
 for(const row of rows){
  if(!row||!Object.hasOwn(networks,row.post_type))continue;
  const [network,...hosts]=networks[row.post_type],id=string(row.id,200),title=string(row.post_title,20000),publishedAt=timestamp(row.post_created,now);
  const url=typeof row.post_link==='string'&&row.post_link.length<=2048&&URL.canParse(row.post_link)?new URL(row.post_link):null;
  if(!id||!title||publishedAt===null||publishedAt<now-86400000||publishedAt>now||!url||url.protocol!=='https:'||url.port||url.username||url.password||!hosts.some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))continue;
  const creatorId=string(row.creator_id,200),interactions24h=count(row.interactions_24h);
  if(!creatorId?.startsWith(networkIds[network]+'::')||!interactions24h||spam.test(title)||promotion.test(title)||/^\s*RT\s+@/iu.test(title)||typeof row.post_description==='string'&&(spam.test(row.post_description)||promotion.test(row.post_description)))continue;
  const excerpt=title.slice(0,600).replace(/[\uD800-\uDBFF]$/u,''),headline=excerpt.replace(/https?:\/\/\S+/giu,'').replace(/(?:\s+[#$][\p{L}\p{N}_]+[,.!]*)+\s*$/gu,'').trim();
  if(transferAlert.test(headline)||!(namedTopic[topic].test(headline)||topic==='solana'&&/\bSOL\b/u.test(headline))||!subjectMatter.test(headline)||headline.replace(/[#$][\p{L}\p{N}_]+/gu,'').length<18)continue;
  posts.push({id,symbols:[assets[topic]],network,title:excerpt,url:url.href,creatorId,publishedAt,interactions24h});
 }
 return posts;
}

function creatorRows(rows){
 if(!Array.isArray(rows)||rows.length>5000)invalid();
 const creators=new Map(),duplicates=new Set();
 for(const record of rows){
  const creatorId=string(record?.creator_id,200),parts=/^(twitter|youtube|reddit|tiktok|instagram|facebook)::([A-Za-z0-9_-]{1,100})$/.exec(creatorId||'');
  if(!parts)continue;
  const [,network,nativeId]=parts,author=string(record.creator_name,100),followers=count(record.creator_followers),topicRank=count(record.creator_rank),creatorInteractions24h=count(record.interactions_24h);
  if(creators.has(creatorId)){duplicates.add(creatorId);continue;}
  let profileUrl=null;
  if(network==='twitter'&&/^\d+$/.test(nativeId))profileUrl='https://x.com/i/user/'+nativeId;
  else if(network==='youtube'&&/^UC[A-Za-z0-9_-]{22}$/.test(nativeId))profileUrl='https://www.youtube.com/channel/'+nativeId;
  else if(network==='facebook'&&/^\d+$/.test(nativeId))profileUrl='https://www.facebook.com/profile.php?id='+nativeId;
  else if(author&&/^[A-Za-z0-9_.-]{1,80}$/.test(author)){
   if(network==='tiktok')profileUrl='https://www.tiktok.com/@'+author;
   if(network==='instagram')profileUrl='https://www.instagram.com/'+author+'/';
   if(network==='reddit')profileUrl='https://www.reddit.com/user/'+author+'/';
  }
  creators.set(creatorId,{author,profileUrl,followers,topicRank,creatorInteractions24h});
 }
 for(const id of duplicates)creators.delete(id);
 return creators;
}

function selectKols(results){
 const checkedTopics=[],failedTopics=[],rankedIds=new Set(),qualifiedIds=new Set(),perTopic=[],textAuthors=new Map();
 for(const group of results.filter(row=>row.resource==='posts'))for(const post of group.rows){
  const text=textKey(post.title);
  if(!textAuthors.has(text))textAuthors.set(text,post.creatorId);
  else if(textAuthors.get(text)!==post.creatorId)textAuthors.set(text,null);
 }
 for(const [topic,symbol] of Object.entries(assets)){
  const get=resource=>results.find(row=>row.topic===topic&&row.resource===resource)?.rows;
  const creators=get('creators'),posts=get('posts'),authors=new Map();
  if(creators)for(const id of creators.keys())rankedIds.add(id);
  if(!creators||!posts){failedTopics.push(symbol);continue;}
  checkedTopics.push(symbol);
  for(const post of posts){const creator=creators.get(post.creatorId),text=textKey(post.title);
   if(Object.hasOwn(distributionAccounts,post.creatorId)||textAuthors.get(text)!==post.creatorId||!creator?.author||!creator.profileUrl||creator.followers<kolRules.minFollowers||!creator.topicRank||creator.topicRank>kolRules.maxTopicRank||creator.creatorInteractions24h<kolRules.minCreatorInteractions24h)continue;
   if(!authors.has(post.creatorId))authors.set(post.creatorId,{posts:new Map(),urls:new Set(),texts:new Set()});
   const candidates=authors.get(post.creatorId);
   if(!candidates.posts.has(post.id)&&!candidates.urls.has(post.url)&&!candidates.texts.has(text)){candidates.posts.set(post.id,post);candidates.urls.add(post.url);candidates.texts.add(text);}
  }
  const best=[];
  for(const [creatorId,{posts:distinct}] of authors){
   if(distinct.size<kolRules.minDistinctPosts)continue;
   qualifiedIds.add(creatorId);const sorted=[...distinct.values()].sort((left,right)=>right.interactions24h-left.interactions24h||right.publishedAt-left.publishedAt);
   best.push({...sorted[0],...creators.get(creatorId),qualifyingPostCount:distinct.size,evidenceSymbol:symbol,runnerUpInteractions:sorted[1].interactions24h});
  }
  perTopic.push(best.sort((left,right)=>right.runnerUpInteractions-left.runnerUpInteractions||left.topicRank-right.topicRank||right.interactions24h-left.interactions24h));
 }
 const featured=new Map();
 for(let slot=0;slot<10;slot++)for(const candidates of perTopic){
  while(candidates.length){const {runnerUpInteractions,...post}=candidates.shift(),old=featured.get(post.creatorId);
   if(old){if(post.id===old.id&&!old.symbols.includes(post.evidenceSymbol))old.symbols.push(post.evidenceSymbol);continue;}
   featured.set(post.creatorId,post);break;
  }
 }
 return {posts:[...featured.values()],curation:{...kolRules,checkedTopics,failedTopics,rankedCreators:rankedIds.size,qualifiedCreators:qualifiedIds.size}};
}

export async function fetchLunarCrush(fetchImpl,key,signal){
 if(typeof key!=='string'||!key.trim()||/[\r\n]/.test(key))throw Error('AUTH_REQUIRED');
 const timeout=AbortSignal.timeout(8000),requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
 const tasks=Object.keys(assets).flatMap(topic=>['topic','posts','creators'].map(async resource=>{
  const url='https://lunarcrush.com/api4/public/topic/'+topic+(resource==='topic'?'/v1':'/'+resource+'/v1');
  try{
   const response=await fetchImpl(url,{method:'GET',headers:{Authorization:'Bearer '+key.trim(),Accept:'application/json'},credentials:'omit',redirect:'error',signal:requestSignal});
   const body=await readJSON(response,resource==='topic'?65536:8*1024*1024),now=Date.now(),config=body?.config;
   if(!(resource==='creators'&&config==null)&&(!config||(config.topic??config.id)!==topic||(config.symbol!==undefined&&config.symbol!==assets[topic])))invalid();
   const asOf=config?.generated==null?null:timestamp(config.generated,now);if(config?.generated!=null&&asOf===null)invalid();
   return {topic,resource,rows:resource==='topic'?[topicRow(body.data,topic,asOf)]:resource==='creators'?creatorRows(body.data):postRows(body.data,topic,now)};
  }catch(error){
   const code=requestSignal.aborted?'TIMEOUT':providerCodes.has(error.message)?error.message:error instanceof SyntaxError?'INVALID_DATA':'UNAVAILABLE';
   return {error:{symbol:assets[topic],resource,code}};
  }
 }));
 const results=await Promise.all(tasks),errors=results.filter(row=>row.error).map(row=>row.error);
 if(errors.length===results.length)throw Error(errors.every(row=>row.code===errors[0].code)?errors[0].code:'UNAVAILABLE');
 const topics=results.filter(row=>row.resource==='topic').flatMap(row=>row.rows),selection=selectKols(results);
 if(!topics.length&&!selection.curation.checkedTopics.length)throw Error('UNAVAILABLE');
 return {provider:'LunarCrush',observedAt:Date.now(),topics,...selection,errors};
}
