import test from 'node:test';
import assert from 'node:assert/strict';
import {createLicensedFeeds} from './licensed-feeds.mjs';
import {validatePublicEnvelope} from './public-data-client.mjs';
const at=Date.UTC(2026,10,18,3);
async function request(handler,query,method='GET'){
 const result={};await handler({url:'/api/market-hub?'+query,method},{writeHead(status){result.status=status},end(body){result.body=JSON.parse(body)}});return result;
}
const article=(id,ago)=>({id,title:'BTC '+id,url:'https://m.theblockbeats.info/flash/'+id,publishedAt:at-ago,revision:null,symbols:['BTC']});
test('publishers merge by original time, retain attribution and report a failed publisher',async()=>{
 const rows=[article('42',2000),article('43',1000)];
 const load=(coindesk)=>createLicensedFeeds({now:()=>at,coindesk,blockbeats:async()=>[rows[0]]});
 const h=load(async()=>[{...rows[1],url:'https://www.coindesk.com/story'}]);const resp=await request(h,'resource=news');
 assert.equal(resp.status,200);const body=validatePublicEnvelope(resp.body,'news');assert.deepEqual(body.items.map(item=>item.provider_id),['coindesk-rss-v1','blockbeats-news-v1']);assert.equal(body.items[1].data.published_at_ms,at-2000);
 const partial=await request(load(async()=>{throw Error('TIMEOUT')}),'resource=news');assert.equal(partial.body.quality,'partial');assert.equal(partial.body.sources[1].status,'UNAVAILABLE');assert.equal(partial.body.items.length,1);
});
test('LunarCrush query controls cannot trigger extra reads; denied upstream never switches providers',async()=>{
 const curation={minFollowers:50000,maxTopicRank:100,minCreatorInteractions24h:1000,minDistinctPosts:2,maxPostsPerAuthor:1,checkedTopics:['BTC','ETH','SOL'],failedTopics:[],rankedCreators:0,qualifiedCreators:0};
 let calls=0;const snapshot={observedAt:at,topics:[],posts:[],errors:[],curation};
 const stored=new Map(),cache={get:async key=>stored.get(key),set:async(key,value)=>stored.set(key,value)};
 const options={now:()=>at,cache,lunarcrush:async()=>{calls++;return snapshot}};
 const h=createLicensedFeeds(options);
 assert.equal((await request(h,'resource=social&topic=other')).status,400);
 const responses=await Promise.all([request(h,'resource=social&limit=1'),request(h,'resource=social&limit=50&selection_version=9')]);
 assert.equal(responses[1].body.selection_version,9);assert.equal(responses[0].body.sources[0].provider_id,'lunarcrush-v4');assert.equal(calls,1);
 assert.equal((await request(createLicensedFeeds(options),'resource=social')).body.coverage.observed_at_ms,at);assert.equal(calls,1);
 const denied=createLicensedFeeds({lunarcrush:async()=>{throw Error('FORBIDDEN')}});assert.equal((await request(denied,'resource=social')).status,503);
 const unfiltered=createLicensedFeeds({now:()=>at,lunarcrush:async()=>({...snapshot,curation:null})});assert.equal((await request(unfiltered,'resource=social')).status,503);
 assert.equal((await request(h,'resource=social','POST')).status,405);
});
