import test from 'node:test';
import assert from 'node:assert/strict';
import {PUBLIC_SOCIAL_SOURCE,normalizePublicSocial,projectPublicSocial} from './public-social.mjs';
import {validatePublicEnvelope} from './public-data-client.mjs';

const now=Date.UTC(2026,10,17,15),published=now-60000;
function post({id='1',tagNames=['bitcoin'],...patch}={}){
 return {id,uri:`https://mastodon.social/users/alice/statuses/${id}`,url:`https://mastodon.social/@alice/${id}`,created_at:new Date(published).toISOString(),edited_at:null,visibility:'public',sensitive:false,spoiler_text:'',content:'<p>Bitcoin &amp; Ethereum discussion</p>',tags:tagNames.map(name=>({name,url:'https://mastodon.social/tags/'+name})),account:{id:'42',acct:'alice',display_name:'Alice',url:'https://mastodon.social/@alice',bot:false},favourites_count:0,reblogs_count:2,replies_count:3,reblog:null,...patch};
}
const feeds=(...rows)=>[rows,[],[]];
const project=(snapshot,at=now,query={selection_version:7,limit:20})=>projectPublicSocial(snapshot,query,at);
test('fixed anonymous source has three immutable tag URLs and bounded polling policy',()=>{
 assert.deepEqual(PUBLIC_SOCIAL_SOURCE.urls,['bitcoin','ethereum','solana'].map(tag=>`https://mastodon.social/api/v1/timelines/tag/${tag}?limit=10`));
 assert.equal(PUBLIC_SOCIAL_SOURCE.provider,'Mastodon.social');assert.equal(PUBLIC_SOCIAL_SOURCE.interval,120000);assert.equal(PUBLIC_SOCIAL_SOURCE.stale,300000);assert.equal(PUBLIC_SOCIAL_SOURCE.maxBytes,200000);
 assert.equal(Object.isFrozen(PUBLIC_SOCIAL_SOURCE),true);assert.equal(Object.isFrozen(PUBLIC_SOCIAL_SOURCE.urls),true);
});
test('actual post shape projects author, source clocks and observed interactions without HTML, cards or media',()=>{
 const raw=feeds(post({tagNames:['bitcoin','ethereum'],card:{url:'http://127.0.0.1/card',title:'DO NOT FETCH CARD'},media_attachments:[{url:'https://media.invalid/private'}]})),before=structuredClone(raw),snapshot=normalizePublicSocial(raw,now),body=project(snapshot),item=body.items[0],data=item.data;
 assert.equal(validatePublicEnvelope(body,'social',{selection_version:7,limit:20}),body);
 assert.equal(body.tenant_scope,'PUBLIC');assert.equal(body.mode,'live_readonly');assert.equal(body.execution_binding,'NONE');assert.equal(body.real_trading_connected,false);
 assert.equal(item.provider_id,'mastodon-tag-v1');assert.equal(item.venue_or_chain,null);assert.equal(item.event_time_ms,published);assert.equal(item.received_at_ms,now);assert.equal(item.available_at_ms,now);
 assert.equal(data.metric_kind,'PUBLIC_SOCIAL_POST');assert.equal(data.platform,'Mastodon');assert.equal(data.instance,'mastodon.social');assert.equal(data.post_id,'1');assert.equal(data.text,'Bitcoin & Ethereum discussion');assert.equal(data.truncated,false);
 assert.deepEqual(data.author,{acct:'alice',display_name:'Alice',url:'https://mastodon.social/@alice',bot:false});assert.deepEqual(data.symbols,['BTC','ETH']);assert.deepEqual([data.likes,data.reposts,data.replies],[0,2,3]);
 assert.equal(data.published_at_ms,published);assert.equal(data.edited_at_ms,null);assert.equal(data.observed_at_ms,now);assert.equal(item.valid_until_ms,now+300000);assert.equal(body.coverage.scope,'SOCIAL_TAG_SAMPLES');assert.equal(body.coverage.sample_cap,30);assert.deepEqual(body.coverage.tags,['bitcoin','ethereum','solana']);assert.ok(body.missing_capabilities.includes('social.sentiment_score'));
 assert.equal(snapshot.asOf,now);assert.equal(body.as_of_ms,now);assert.equal(body.coverage.as_of_basis,'sample_receipt');
 assert.equal(JSON.stringify(body).includes('DO NOT FETCH CARD'),false);assert.equal(JSON.stringify(body).includes('media.invalid'),false);assert.deepEqual(raw,before);
});
test('symbols derive only from exact tags across all feeds, never from text or the requested source slot',()=>{
 const raw=[[post({id:'1',tagNames:[],content:'<p>Bitcoin Ethereum SOL</p>'})],[post({id:'2',tagNames:['BITCOIN','ethereum','solana','bitcoin']})],[post({id:'3',tagNames:['bitcoiners','wrappedbitcoin','sol']})]],body=project(normalizePublicSocial(raw,now));
 const byId=new Map(body.items.map(item=>[item.data.post_id,item.data.symbols]));assert.deepEqual(byId.get('1'),[]);assert.deepEqual(byId.get('2'),['BTC','ETH','SOL']);assert.deepEqual(byId.get('3'),[]);
});
test('private, sensitive, content-warning and reblog wrapper statuses are omitted without reading their nested content',()=>{
 const raw=feeds(post(),post({id:'2',visibility:'private'}),post({id:'3',sensitive:true}),post({id:'4',spoiler_text:'Spoiler'}),post({id:'5',reblog:{content:'PRIVATE NESTED POST'}}));
 assert.deepEqual(project(normalizePublicSocial(raw,now)).items.map(item=>item.data.post_id),['1']);
 const hidden=post({sensitive:true});assert.equal(normalizePublicSocial([[post()],[hidden],[]],now).items.length,0,'a later exclusion must also suppress the earlier duplicate');
});
test('plain excerpts remove markup and script text, decode entities and truncate without splitting Unicode',()=>{
 const full='x'.repeat(599)+'😀 trailing',snapshot=normalizePublicSocial(feeds(post({content:'<p>'+full+'</p><script>DO NOT SHOW</script><style>HIDE ME</style>'})),now),data=project(snapshot).items[0].data;
 assert.equal(data.text,'x'.repeat(599));assert.equal(data.truncated,true);assert.ok(data.text.length<=600);assert.equal(data.text.includes('DO NOT SHOW'),false);
 const escaped=project(normalizePublicSocial(feeds(post({content:'<p>&lt;b&gt;literal&lt;/b&gt;&nbsp;&#x1F600;<br>Next</p>'})),now)).items[0].data;
 assert.equal(escaped.text,'<b>literal</b> 😀 Next');assert.equal(escaped.truncated,false);
});
test('source identity deduplicates across tags, chooses latest edits and rejects conflicting aliases',()=>{
 const edited=post({edited_at:new Date(now-1000).toISOString(),content:'<p>Edited post</p>',favourites_count:4}),snapshot=normalizePublicSocial([[edited],[post()],[]],now),data=project(snapshot).items[0].data;
 assert.equal(snapshot.items.length,1);assert.equal(data.text,'Edited post');assert.equal(data.likes,4);assert.equal(data.edited_at_ms,now-1000);
 for(const conflicting of [post({uri:'https://mastodon.social/users/bob/statuses/1'}),post({id:'2',uri:post().uri})])assert.throws(()=>normalizePublicSocial([[post()],[conflicting],[]],now),/INVALID_SOCIAL/);
 const raw=feeds(post({id:'2',created_at:new Date(published-1000).toISOString()}),post());assert.equal(project(normalizePublicSocial(raw,now)).items[0].data.post_id,'1');
});
test('source dates and observation expiry never become refresh-time publication or unlimited validity',()=>{
 const old=post({created_at:new Date(now-86400000+1000).toISOString()}),snapshot=normalizePublicSocial(feeds(old),now),first=project(snapshot);
 assert.equal(first.items[0].valid_until_ms,now+1000);assert.equal(project(snapshot,now+1000).quality,'stale');
 const renewed=project(normalizePublicSocial(feeds(old),now+60000),now+60000);assert.equal(renewed.items[0].event_time_ms,first.items[0].event_time_ms);assert.equal(renewed.items[0].valid_until_ms,first.items[0].valid_until_ms);
 assert.equal(project(normalizePublicSocial(feeds(post()),now),now+300000).quality,'stale');
 for(const patch of [{created_at:'not-a-date'},{created_at:'2026-02-30T00:00:00Z'},{created_at:'2026-11-16T24:00:00Z'},{created_at:new Date(now+60001).toISOString()},{edited_at:new Date(published-1).toISOString()},{edited_at:new Date(now+60001).toISOString()}])assert.throws(()=>normalizePublicSocial(feeds(post(patch)),now),/INVALID_SOCIAL/);
 for(const at of [NaN,-1,0,now+.5])assert.throws(()=>normalizePublicSocial(feeds(post()),at),/INVALID_SOCIAL/);
});
test('unknown, negative and unsafe interaction counts fail instead of silently becoming zero',()=>{
 for(const key of ['favourites_count','reblogs_count','replies_count'])for(const value of [undefined,null,'0',-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>normalizePublicSocial(feeds(post({[key]:value})),now),/INVALID_SOCIAL/);
});
test('source links and author fields reject active schemes, userinfo and malformed identities',()=>{
 for(const url of ['http://mastodon.social/@alice/1','javascript:alert(1)','https://u:p@mastodon.social/@alice/1','not a URL']){
  assert.throws(()=>normalizePublicSocial(feeds(post({url})),now),/INVALID_SOCIAL/);assert.throws(()=>normalizePublicSocial(feeds(post({account:{...post().account,url}})),now),/INVALID_SOCIAL/);
 }
 for(const patch of [{id:1},{uri:'javascript:alert(1)'},{account:null},{account:{...post().account,acct:''}},{account:{...post().account,bot:'false'}},{tags:[{name:4}]}])assert.throws(()=>normalizePublicSocial(feeds(post(patch)),now),/INVALID_SOCIAL/);
 const missingBot=post();delete missingBot.account.bot;assert.equal(project(normalizePublicSocial(feeds(missingBot),now)).items[0].data.author.bot,null);
 assert.equal(project(normalizePublicSocial(feeds(post({url:null})),now)).items[0].data.url,post().uri);
});
test('valid empty samples stay distinct from errors, malformed arrays, unknown source bodies and oversized feeds',()=>{
 const body=project(normalizePublicSocial([[],[],[]],now));assert.deepEqual(body.items,[]);assert.equal(body.quality,'fresh');assert.equal(body.sources[0].status,'OK');assert.equal(body.coverage.scope,'SOCIAL_TAG_SAMPLES');
 for(const raw of [null,[],[[]],[[],[]],[[],[],[],[]],{error:'Unauthorized'},[[],{error:'Too many requests'},[]],[[],null,[]],feeds(null),feeds(...Array.from({length:11},(_,i)=>post({id:String(i+1)})))])assert.throws(()=>normalizePublicSocial(raw,now),/INVALID_SOCIAL/);
});
test('each request projects its own selection and limit without mutating the shared thirty-post snapshot',()=>{
 const raw=Array.from({length:3},(_,group)=>Array.from({length:10},(_,i)=>post({id:String(group*10+i+1)}))),snapshot=normalizePublicSocial(raw,now),before=structuredClone(snapshot);
 assert.equal(project(snapshot,now,{selection_version:1,limit:1}).items.length,1);const all=project(snapshot,now,{selection_version:2,limit:50});assert.equal(all.items.length,30);assert.equal(all.selection_version,2);assert.deepEqual(snapshot,before);
 for(const query of [{selection_version:0,limit:0},{selection_version:0,limit:51},{selection_version:-1,limit:10},{selection_version:0,limit:10,owner:'forged'}])assert.throws(()=>project(snapshot,now,query),/INVALID_SOCIAL/);
});
