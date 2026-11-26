import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchLunarCrush} from './public-lunarcrush.mjs';

const stamp=Math.floor(Date.now()/1000)-200;
function reply(url){
 const topic=url.split('/')[6];
 if(url.endsWith('/creators/v1'))return Response.json({data:[{creator_id:'twitter::123',creator_name:'user',creator_followers:50000,creator_rank:100,interactions_24h:1000}]});
 if(url.endsWith('/posts/v1'))return Response.json({config:{id:topic},data:[1,2].map(index=>({id:String(index),post_type:'tweet',post_created:stamp,post_title:'Bitcoin, Ethereum and Solana liquidity '+index,post_link:'https://x.com/user/status/'+index,creator_id:'twitter::123',creator_name:'user',interactions_24h:index}))});
 return Response.json({config:{id:topic},data:{topic,num_posts:0,num_contributors:3,interactions_24h:64,types_sentiment:{tweet:0,'reddit-post':100}}});
}

test('nine fixed authorized endpoints preserve source identities, metrics, clocks and independent KOL evidence',async()=>{
 const paths=[];const result=await fetchLunarCrush(async(url,opts)=>{
  assert.equal(opts.headers.Authorization,'Bearer test-key');assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'omit');
  paths.push(url);return reply(url);
 },'test-key');
 assert.equal(new Set(paths).size,9);assert(paths.every(url=>/^https:\/\/lunarcrush\.com\/api4\/public\/topic\/(bitcoin|ethereum|solana)\/((posts|creators)\/)?v1$/.test(url)));
 assert.deepEqual(result.topics.map(topic=>topic.symbol),['BTC','ETH','SOL']);assert.equal(result.topics[0].asOf,null);
 assert.equal(result.topics[0].posts24h,0);assert.deepEqual(result.topics[0].sentimentByNetwork,{X:0,Reddit:100});
 assert.equal(result.posts.length,1);const [post]=result.posts;
 assert.deepEqual([post.symbols,post.creatorId,post.author,post.followers,post.qualifyingPostCount,post.topicRank,post.creatorInteractions24h,post.profileUrl,post.evidenceSymbol,post.publishedAt,post.interactions24h],[['BTC','ETH','SOL'],'twitter::123','user',50000,2,100,1000,'https://x.com/i/user/123','BTC',stamp*1000,2]);
 assert.equal(result.curation.rankedCreators,1);assert.equal(result.curation.qualifiedCreators,1);
 assert.equal(result.errors.length,0);assert(Number.isSafeInteger(result.observedAt));
});
test('failure of one family does not zero or substitute the other; errors never expose a token',async()=>{
 const result=await fetchLunarCrush(async url=>url.endsWith('/posts/v1')?new Response('private',{status:403}):reply(url),'test-key');
 assert.equal(result.topics.length,3);assert.deepEqual(result.posts,[]);assert(result.errors.length===3&&result.errors.every(issue=>issue.resource==='posts'&&issue.code==='FORBIDDEN'));
 await assert.rejects(fetchLunarCrush(()=>assert.fail('missing credential must not fetch'),''),/^Error: AUTH_REQUIRED$/);
 await assert.rejects(fetchLunarCrush(async()=>new Response('private',{status:401}),'test-key'),/^Error: AUTH_REQUIRED$/);
 await assert.rejects(fetchLunarCrush(async()=>{throw Error('private');},'test-key'),/^Error: UNAVAILABLE$/);
});
test('ambiguous identity, unsafe or mismatched post URLs and invalid timestamps cannot become source evidence',async()=>{
 const result=await fetchLunarCrush(async url=>{
  const {config,data}=await reply(url).json();
  if(url.endsWith('/creators/v1'))return Response.json({data});
  if(Array.isArray(data)){data[0].post_link='https://x.com.evil.example/123';}
  else if(config.id==='bitcoin')data.topic='wrong';
  else if(config.id==='ethereum')config.generated=9999999999999;
  else {config.generated=stamp;data.num_posts=-1;data.types_sentiment={'youtube-video':101};}
  return Response.json({config,data});
 },'test-key');
 assert.equal(result.topics.length,1);assert.equal(result.topics[0].asOf,stamp*1000);
 assert.equal(result.topics[0].posts24h,null);assert.deepEqual(result.topics[0].sentimentByNetwork,{});
 assert.equal(result.posts.length,0);assert.equal(result.errors.filter(issue=>issue.code==='INVALID_DATA').length,2);
});

test('never fill a KOL slot with missing-rank/low-follower, wrong-ID, one-hit, duplicate, old, promo or off-topic posts',async()=>{
 for(const change of [
  (rows,resource)=>{if(resource==='creators')delete rows[0].creator_followers;},
  (rows,resource)=>{if(resource==='creators')rows[0].creator_followers=49999;},
  (rows,resource)=>{if(resource==='creators')rows[0].creator_rank=101;},
  (rows,resource)=>{if(resource==='creators')rows[0].interactions_24h=999;},
  (rows,resource)=>{if(resource==='posts')rows[0].creator_id='twitter::999';},
  (rows,resource)=>{if(resource==='posts')rows[0].creator_id='reddit::123';},
  (rows,resource)=>{if(resource==='posts')rows[0].post_created-=86401;},
  (rows,resource)=>{if(resource==='posts')rows[0].post_link=rows[1].post_link;},
  (rows,resource)=>{if(resource==='posts')rows[0].interactions_24h=0;},
  (rows,resource)=>{if(resource==='posts')rows[0].post_title='Bitcoin, Ethereum, Solana: join our giveaway';},
  (rows,resource)=>{if(resource==='posts')rows[0].post_title='Everyone should be smart enough to buy Bitcoin, Ethereum or Solana.';},
  (rows,resource)=>{if(resource==='posts')rows[0].post_title='The latest political commentary #bitcoin #ethereum $SOL';},
  (rows,resource)=>{if(resource==='posts')rows[0].post_title='🚨 12,000 $ETH (21,876,128 USD) of stolen funds transferred from Binance Hack 2026 to unknown wallet';},
  (rows,resource)=>{if(resource==='posts')rows[0].post_title='Buy Bitcoin, Ethereum or Solana for staking rewards with this promo code';},
  (rows,resource)=>{if(resource==='posts')rows[0].post_title=rows[1].post_title.toUpperCase()+'!  https://example.org';},
  (rows,resource)=>{if(resource==='posts')rows.push({...rows[0],creator_id:'twitter::345',id:'copied',post_link:'https://x.com/copy/status/34'});},
  (rows,resource)=>{if(resource==='posts')rows[0].post_description='Registration is available using our referral code.';}
 ]){
  const result=await fetchLunarCrush(async url=>{const body=await reply(url).json(),resource=url.split('/').at(-2);if(Array.isArray(body.data))change(body.data,resource);return Response.json(body);},'test-key');
  assert.equal(result.posts.length,0);assert.equal(result.curation.qualifiedCreators,0);assert.deepEqual(result.curation.failedTopics,[]);
 }
});
test('known publisher, project and automatic accounts remain excluded even after a display-name change',async()=>{
 for(const creatorId of ['twitter::1039833297751302144','twitter::1852674305517342720','twitter::951329744804392960','twitter::2207129125','twitter::111533746']){
  const result=await fetchLunarCrush(async url=>{const body=await reply(url).json();
   if(Array.isArray(body.data))for(const record of body.data){record.creator_id=creatorId;record.creator_name='renamed_analyst';}
   return Response.json(body);
  },'test-key');
  assert.equal(result.posts.length,0);assert.equal(result.curation.qualifiedCreators,0);
 }
});
test('missing creator-list access yields explicitly incomplete coverage with no unqualified fallback',async()=>{
 const result=await fetchLunarCrush(async url=>url.includes('/creators/')?new Response(null,{status:403}):reply(url),'test-key');
 assert.equal(result.topics.length,3);assert.equal(result.posts.length,0);assert.deepEqual(result.curation.checkedTopics,[]);assert.deepEqual(result.curation.failedTopics,['BTC','ETH','SOL']);assert(result.errors.every(issue=>issue.resource==='creators'&&issue.code==='FORBIDDEN'));
});
