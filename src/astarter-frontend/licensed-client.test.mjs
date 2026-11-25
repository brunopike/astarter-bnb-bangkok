import assert from 'node:assert/strict';
import test from 'node:test';
import {PUBLIC_SCHEMA,PUBLIC_PROJECTION,currentPublicEnvelope,validatePublicEnvelope} from './public-data-client.mjs';
import {MarketResearch} from './live-research.mjs';
import {workbenchFeedSelection,workbenchInformation} from './workbench-console.mjs';

const now=Date.UTC(2026,10,18,3),hour=3600000;
function sample(){
 const published=now-3*24*hour;
 const topic={symbol:'BTC',topic:'bitcoin',asOf:null,posts24h:0,contributors24h:null,interactions24h:32,sentimentByNetwork:{X:0,Reddit:69.5}};
 const item={record_id:'lunarcrush-v4:X:123',subject_id:'social:X:123',provider_id:'lunarcrush-v4',quality:'fresh',event_time_ms:published,received_at_ms:now,available_at_ms:now,valid_until_ms:now+hour,venue_or_chain:null,source_revision:null,data:{metric_kind:'LUNARCRUSH_POST',post_id:'123',platform:'X',url:'https://x.com/demo/status/123',text:'offline title v4',author:{acct:null,display_name:null,url:null,bot:null},symbols:['BTC','ETH'],published_at_ms:published,observed_at_ms:now,interactions_24h:0}};
 return {schema_version:PUBLIC_SCHEMA,projection_version:PUBLIC_PROJECTION,tenant_scope:'PUBLIC',selection_version:0,mode:'live_readonly',execution_binding:'NONE',real_trading_connected:false,request_id:'test',requested_at_ms:now,as_of_ms:now,quality:'fresh',coverage:{scope:'LUNARCRUSH_TOPICS',observed_at_ms:now,topics:[topic],errors:[]},sources:[{provider_id:'lunarcrush-v4',status:'OK',last_success_at_ms:now,reason_code:null,retry_after_seconds:null}],items:[item],missing_capabilities:[]};
}
test('LunarCrush validates the source, platform links, time, topic identity, metrics and their units',()=>{
 const good=sample();good.items[0].data.text='✨'.repeat(598)+'🚀🚀';good.items[0].data.interactions_24h=null;
 assert.equal(validatePublicEnvelope(good,'social').items[0].data.interactions_24h,null);
 for(const change of [
  body=>{body.sources[0].provider_id='mastodon-tag-v1'},body=>{body.items[0].provider_id='mastodon-tag-v1'},
  body=>{body.items[0].data.url='https://lookalike.test/twitter.com'},body=>{body.items[0].data.url='https://x.com:8443/demo'},
  body=>{body.items[0].data.platform='Reddit'},body=>{body.coverage.topics[0].symbol='SOL'},
  body=>body.coverage.topics.push(body.coverage.topics[0]),body=>{body.coverage.topics[0].sentimentByNetwork.X=120},
  body=>{body.coverage.errors=[{symbol:'BTC',resource:'other',code:'ERR'}]},body=>{body.coverage.topics[0].posts24h=-1},
  body=>{body.items[0].data.symbols=[]},body=>{body.items[0].valid_until_ms++},body=>{body.items[0].data.interactions_24h=1.2},
  body=>{body.coverage.observed_at_ms=now+3600000},body=>{body.items[0].data.text='🚀'.repeat(601)}
 ]){const body=sample();change(body);assert.throws(()=>validatePublicEnvelope(body,'social'),/DATA_RESPONSE_INVALID/);}
});
function curated(){
 const source=sample(),item=source.items[0],data=item.data;
 source.coverage.scope='LUNARCRUSH_KOL_TOPICS';source.coverage.curation={minFollowers:50000,maxTopicRank:100,minCreatorInteractions24h:1000,minDistinctPosts:2,maxPostsPerAuthor:1,checkedTopics:['BTC','ETH'],failedTopics:['SOL'],rankedCreators:40,qualifiedCreators:2};
 source.quality='partial';source.coverage.errors=[{symbol:'SOL',resource:'creators',code:'RATE_LIMIT'}];
 data.published_at_ms=item.event_time_ms=now-10000;data.author.acct='author';data.interactions_24h=200;
 data.kol={creatorId:'twitter::123',followers:51002,topicRank:9,creatorInteractions24h:4521,qualifyingPostCount:4,profileUrl:'https://x.com/i/user/123',evidenceSymbol:'BTC'};
 return source;
}
test('KOL posts require native platform IDs, minimum thresholds, verified topic and one post per account',()=>{
 assert.equal(validatePublicEnvelope(curated(),'social').items.length,1);
 for(const change of [
  envelope=>{envelope.coverage.curation.minFollowers=49999},envelope=>{envelope.coverage.curation.maxPostsPerAuthor=2},
  envelope=>{envelope.coverage.curation.checkedTopics.push('SOL')},envelope=>{envelope.coverage.curation.qualifiedCreators=41},
  envelope=>{envelope.items[0].data.kol.followers=49999},envelope=>{envelope.items[0].data.kol.creatorInteractions24h=999},
  envelope=>{envelope.items[0].data.kol.qualifyingPostCount=1},envelope=>{envelope.items[0].data.kol.topicRank=101},
  envelope=>{envelope.items[0].data.kol.profileUrl='https://reddit.com/user/123'},envelope=>{envelope.items[0].data.kol.creatorId='youtube::123'},
  envelope=>{envelope.items[0].data.kol.evidenceSymbol='SOL'},envelope=>{envelope.items[0].data.symbols=['ETH']},
  envelope=>{const extra=structuredClone(envelope.items[0]);extra.record_id='another-post';envelope.items.push(extra);}
 ]){const body=curated();change(body);assert.throws(()=>validatePublicEnvelope(body,'social'),/DATA_RESPONSE_INVALID/);}
 const noProfile=curated();noProfile.items[0].data.kol.profileUrl=null;assert.equal(validatePublicEnvelope(noProfile,'social').items.length,1);
});
test('the live workbench distinguishes vetted KOLs and topic-wide data; legacy posts and expired reads cannot backfill it',()=>{
 const source=curated(),research=new MarketResearch({now:()=>now/1000});
 const rows=(body,at=now)=>workbenchInformation(research,null,{socialSnapshot:body,now:at}).filter(row=>row.kind==='social');
 assert.equal(validatePublicEnvelope(sample(),'social').items.length,1);assert.deepEqual(rows(sample()),[]);
 const [post,topic]=rows(source);
 assert.equal(post.at,source.items[0].event_time_ms);assert.equal(post.url,source.items[0].data.url);assert.equal(post.source,'LunarCrush · X');
 assert.ok(post.text.includes(source.items[0].data.text));assert.match(post.hint,/51,002/);assert.match(post.hint,/BTC #9/);assert.match(post.detail,/200/);assert.doesNotMatch(post.detail,/likes|reposts|replies|赞|转发|回复/i);
 assert.equal(topic.source,'LunarCrush');assert.match(topic.hint,/32/);assert.doesNotMatch(topic.hint,/authors|contributors|作者/i);
 assert.match(topic.detail,/X 0\/100/);assert.match(topic.detail,/Reddit 69.5\/100/);assert.match(topic.detail,/Observed|采样时间/);
 const crowded=Array.from({length:30},(_,index)=>({...post,id:'social:'+index}));assert.ok(workbenchFeedSelection([...crowded,topic],'social').includes(topic));
 assert.deepEqual(workbenchFeedSelection([post,topic],'social','ETH'),[post]);
 const noRank=curated();noRank.items=[];noRank.coverage.curation={...noRank.coverage.curation,checkedTopics:[],failedTopics:['BTC','ETH','SOL'],rankedCreators:0,qualifiedCreators:0};
 assert.ok(rows(noRank).every(row=>row.id.startsWith('social:topic:')));
 for(const empty of [false,true]){
  const body=curated();if(empty)body.items=[];
  const expired=currentPublicEnvelope(body,now+hour),failed=currentPublicEnvelope(body,now+1,true);
  assert.equal(expired.quality,'stale');assert.equal(failed.quality,'stale');assert.deepEqual(rows(expired,now+hour),[]);assert.deepEqual(rows(failed,now+1),[]);
 }
});
