import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {schnorr} from '@noble/curves/secp256k1';
import {createLicensedFeeds} from './licensed-feeds.mjs';
import {validatePublicEnvelope} from './public-data-client.mjs';
import {fetchBlueskyLatest,fetchNostrLatest} from './public-social-latest.mjs';
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

test('recent and featured share a five-minute snapshot while recent posts do not require KOL qualification',async()=>{
 let clock=at,calls=0;
 const curation={minFollowers:50000,maxTopicRank:100,minCreatorInteractions24h:1000,minDistinctPosts:2,maxPostsPerAuthor:1,checkedTopics:['BTC','ETH','SOL'],failedTopics:[],rankedCreators:0,qualifiedCreators:0};
 const offline=async()=>{throw Error('UNAVAILABLE');};
 const handler=createLicensedFeeds({now:()=>clock,bluesky:offline,nostr:offline,lunarcrush:async()=>{
  calls++;
  return {observedAt:clock,topics:[],posts:[],curation,errors:[],discovery:{category:'cryptocurrencies',status:'OK'},recentPosts:[{id:'fresh',network:'X',title:'XRP settlement fees after a protocol upgrade',url:'https://x.com/analyst/status/987',creatorId:'twitter::987',author:'analyst',symbols:[],publishedAt:clock-1000,interactions24h:0}]};
 }});
 const first=await request(handler,'resource=social&feed=recent');
 assert.equal(first.status,200);assert.equal(first.body.items[0].data.post_id,'fresh');assert.equal(first.body.items[0].data.kol,undefined);
 assert.equal((await request(handler,'resource=social&feed=featured')).body.items.length,0);assert.equal(calls,1);
 clock+=299999;await request(handler,'resource=social&feed=recent');assert.equal(calls,1);
 clock++;const updated=await request(handler,'resource=social&feed=recent');assert.equal(calls,2);assert.equal(updated.body.coverage.observed_at_ms,clock);
 assert.equal((await request(handler,'resource=social&feed=other')).status,400);
});

test('recent public posts keep their direct source clocks and token/platform filters reuse one upstream read',async()=>{
 let clock=at,lunarReads=0,blueskyReads=0,nostrReads=0;
 const creatorId='did:plc:abcdefghijklmnopqrstuvwx',id='3abc',acct='analyst.bsky.social',lunar=at-240_000;
 const coverage={minFollowers:50000,maxTopicRank:100,minCreatorInteractions24h:1000,minDistinctPosts:2,maxPostsPerAuthor:1,checkedTopics:['BTC','ETH','SOL'],failedTopics:[],rankedCreators:0,qualifiedCreators:0};
 const lunarcrush=async()=>{
  lunarReads++;
  return {observedAt:lunar,topics:[],posts:[],curation:coverage,errors:[],discovery:{category:'cryptocurrencies',status:'OK'},recentPosts:[{id:'75',network:'X',title:'Bitcoin ETF holdings gain after inflows',url:'https://x.com/analyst/status/75',creatorId:'twitter::75',author:'analyst',symbols:['BTC'],publishedAt:at-2_400_000,interactions24h:125}]};
 };
 const bluesky=async()=>{
  blueskyReads++;
  return {observedAt:clock,failedSymbols:[],posts:[{id,network:'Bluesky',creatorId,author:{acct,display_name:'Research Desk',url:'https://bsky.app/profile/'+creatorId,bot:null},title:'XRP settlement fees fall after the protocol upgrade',url:'https://bsky.app/profile/'+creatorId+'/post/'+id,symbols:['XRP'],publishedAt:clock-30_000,likes:0,reposts:1,replies:null}]};
 };
 const nostr=async()=>{nostrReads++;throw Error('UNAVAILABLE');};
 const handler=createLicensedFeeds({now:()=>clock,lunarcrush,bluesky,nostr});
 const first=await request(handler,'resource=social&feed=recent');
 assert.equal(first.status,200);
 assert.equal(first.body.quality,'partial');
 assert.deepEqual(first.body.items.map(item=>[item.provider_id,item.event_time_ms,item.received_at_ms]),[
  ['bluesky-latest-v1',at-30_000,at],['lunarcrush-v4',at-2_400_000,lunar]
 ]);
 const filtered=await request(handler,'resource=social&feed=recent&symbol=XRP&platform=Bluesky');
 assert.equal(filtered.status,200);assert.deepEqual(filtered.body.items.map(item=>item.data.symbols),[['XRP']]);
 assert.equal(lunarReads,1);assert.equal(blueskyReads,1);assert.equal(nostrReads,1);
 assert.equal((await request(handler,'resource=social&feed=featured&platform=Bluesky')).status,400);
 assert.equal((await request(handler,'resource=social&feed=featured')).body.coverage.scope,'LUNARCRUSH_KOL_TOPICS');
 const invalid=structuredClone(filtered.body);invalid.items[0].data.symbols=['BTC'];
 assert.throws(()=>validatePublicEnvelope(invalid,'social',{feed:'recent',symbol:'XRP',platform:'Bluesky'}),/DATA_RESPONSE_INVALID/);
 clock+=61_000;
 const next=await request(handler,'resource=social&feed=recent');
 assert.equal(next.body.as_of_ms,clock);assert.equal(blueskyReads,2);assert.equal(lunarReads,1);
});

test('Bluesky latest search preserves original time and canonical authors while dropping mislabeled or promotional results',async()=>{
 const author={did:'did:plc:abcdefghijklmnopqrstuvwx',handle:'desk.bsky.social'};
 const good={author,uri:'at://'+author.did+'/app.bsky.feed.post/3good',indexedAt:new Date(at-400).toISOString(),likeCount:0,
  record:{$type:'app.bsky.feed.post',createdAt:new Date(at-26_000).toISOString(),text:'~~~~~~\nXRP settlement fees fell after the protocol upgrade\n\n\nhttps://example.test/article\n\nPrior refunds have settled.'}};
 const {observedAt,posts,failedSymbols}=await fetchBlueskyLatest(async url=>{
  const parsed=new URL(url);
  assert.equal(parsed.origin,'https://api.bsky.app');assert.equal(parsed.searchParams.get('sort'),'latest');
  const q=parsed.searchParams.get('q');
  if(q==='"Sui Network"')return new Response(null,{status:429});
  if(q==='Chainlink')return Response.json({posts:[{...good,uri:good.uri+'d',
   record:{...good.record,text:'Replace the chainlink fence for network cable installation'}}]});
  if(q!=='XRP')return Response.json({posts:[]});
  return Response.json({posts:[good,
   {...good,uri:good.uri+'a',labels:[{val:'!no-unauthenticated'}]},
   {...good,uri:good.uri+'b',record:{...good.record,text:'XRP protocol upgrade: claim your airdrop now'}},
   {...good,uri:'at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/app.bsky.feed.post/3foreign'},
   {...good,uri:good.uri+'c',record:{...good.record,createdAt:new Date(at+1000).toISOString()}}]});
 },AbortSignal.timeout(3000),()=>at);
 assert.equal(observedAt,at);assert.deepEqual(failedSymbols,['SUI']);
 assert.deepEqual(posts.map(post=>[post.id,post.symbols,post.publishedAt,post.likes,post.replies]),[
  ['3good',['XRP'],at-26_000,0,null]
 ]);
 assert.equal(posts[0].url,'https://bsky.app/profile/'+author.did+'/post/3good');
 assert.equal(posts[0].title,'XRP settlement fees fell after the protocol upgrade\n\nPrior refunds have settled.');
});

test('Nostr public feed accepts signed original notes and drops a tampered, reply or solicitation note',async()=>{
 const signer=new Uint8Array(32);signer[31]=1;
 const pubkey=Buffer.from(schnorr.getPublicKey(signer)).toString('hex'),created_at=at/1000-45;
 const signed=(content,tags=[['t','monero']])=>{
  const id=createHash('sha256').update(JSON.stringify([0,pubkey,created_at,1,tags,content])).digest('hex');
  return {kind:1,id,pubkey,created_at,tags,content,sig:Buffer.from(schnorr.sign(id,signer)).toString('hex')};
 };
 const good=signed('Monero developers shipped a protocol privacy update after the audit');
 const tampered={...good,content:'Monero developers reported transactions in their nightly protocol tests'};
 const reply=signed('Monero protocol fees have changed after the latest upgrade',[['t','monero'],['e','1'.repeat(64)]]);
 const ad=signed('Monero protocol upgrade: verify your wallet to claim your free rewards');
 const referral=signed('Join the snapshot ETH reward program at https://offers.example.test/?ref=abc. Max 1 claim per wallet.');
 class Relay extends EventTarget{
  constructor(url){
   super();assert.equal(url,'wss://relay.primal.net');
   queueMicrotask(()=>this.dispatchEvent(new Event('open')));
  }
  send(payload){
   const [action,subscription,...filters]=JSON.parse(payload);assert.equal(action,'REQ');
   assert.equal(filters.reduce((total,filter)=>total+filter.limit,0),160);
   for(const row of [good,tampered,reply,ad,referral])this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(['EVENT',subscription,row])}));
   this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(['EOSE',subscription])}));
  }
  close(){}
 }
 const {posts}=await fetchNostrLatest(AbortSignal.timeout(3000),()=>at,Relay);
 assert.deepEqual(posts.map(post=>[post.id,post.symbols,post.publishedAt,post.likes]),[[good.id,['XMR'],at-45_000,null]]);
 assert.equal(posts[0].url,'https://primal.net/e/'+good.id);
});
