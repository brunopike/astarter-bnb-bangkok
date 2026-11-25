import assert from 'node:assert/strict';
import test from 'node:test';
import {createLiveDataViews,liveDataRoute,validateLiveDataResponse} from './data-live-views.mjs';

const NOW=Date.UTC(2026,10,18,6),HOUR=3600000;
function curated({qualified=true,verified=true,partial=false}={}){
 const policy={minFollowers:50000,maxTopicRank:100,minCreatorInteractions24h:1000,minDistinctPosts:2,maxPostsPerAuthor:1,rankedCreators:9,qualifiedCreators:qualified&&verified?1:0,checkedTopics:verified?(partial?['BTC','ETH']:['BTC','ETH','SOL']):[],failedTopics:verified?(partial?['SOL']:[]):['BTC','ETH','SOL']};
 const item={record_id:'lunarcrush:x-123',subject_id:'x-123',provider_id:'lunarcrush-v4',quality:'fresh',event_time_ms:NOW-60000,received_at_ms:NOW,available_at_ms:NOW,valid_until_ms:NOW+HOUR,venue_or_chain:null,source_revision:null,data:{metric_kind:'LUNARCRUSH_POST',post_id:'x-123',platform:'YouTube',text:'QUALIFIED_CREATOR_POST <img>',url:'https://www.youtube.com/watch?v=clip-id',author:{acct:'Creator Name',display_name:'Creator Name',url:null,bot:null},symbols:['BTC'],published_at_ms:NOW-60000,observed_at_ms:NOW,interactions_24h:485,kol:{creatorId:'youtube::UC-example',followers:654321,topicRank:17,profileUrl:'https://www.youtube.com/channel/UC-example',creatorInteractions24h:17000,qualifyingPostCount:3,evidenceSymbol:'BTC'}}};
 return {schema_version:'AstarterPublicData.v1',tenant_scope:'PUBLIC',projection_version:'public-data-projection.v1',request_id:'social-'+NOW,selection_version:0,mode:'live_readonly',real_trading_connected:false,execution_binding:'NONE',quality:partial||!verified?'partial':'fresh',as_of_ms:NOW,requested_at_ms:NOW,coverage:{scope:'LUNARCRUSH_KOL_TOPICS',observed_at_ms:NOW,topics:[{symbol:'BTC',topic:'bitcoin',asOf:null,posts24h:100,contributors24h:30,interactions24h:1234,sentimentByNetwork:{X:50}}],errors:partial||!verified?[{symbol:'SOL',resource:'creators',code:'UNAVAILABLE'}]:[],curation:policy},missing_capabilities:['social.individual_engagement_breakdown'],sources:[{provider_id:'lunarcrush-v4',status:'OK',last_success_at_ms:NOW,reason_code:null,retry_after_seconds:null}],items:qualified&&verified?[item]:[]};
}
function recent(){
 const body=curated();body.coverage.scope='LUNARCRUSH_TOPICS';body.coverage.feed='recent';body.coverage.discovery={category:'cryptocurrencies',status:'OK'};delete body.coverage.curation;
 body.items[0].data.creator_id=body.items[0].data.kol.creatorId;delete body.items[0].data.kol;body.items[0].data.symbols=[];body.items[0].data.text='RECENT_CRYPTO_POST';return body;
}
function mastodon(){
 const body=curated(),item=body.items[0];body.coverage={scope:'SOCIAL_TAG_SAMPLES'};body.sources[0].provider_id=item.provider_id='mastodon-tag-v1';item.valid_until_ms=NOW+300000;
 item.data={metric_kind:'PUBLIC_SOCIAL_POST',platform:'Mastodon',instance:'mastodon.social',post_id:'123',url:'https://mastodon.social/@alice/123',author:{acct:'alice',display_name:'Alice',url:'https://mastodon.social/@alice',bot:false},text:'WRONG_MASTODON_CHANNEL',truncated:false,published_at_ms:NOW-60000,edited_at_ms:null,observed_at_ms:NOW,symbols:['BTC'],likes:0,reposts:0,replies:0};return body;
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const address='0x'+'a'.repeat(40);
function traderReceipt({profile=false,empty=false}={}){
 const venue={source:'Hyperliquid',network:'mainnet',currency:'USD'};
 const body=profile?{...venue,kind:'profile',address,positionsScope:'default-perp-dex',positionsAsOf:NOW,positions:[],fills:[],perpAccountValue:123,
  performance:['day','week','month','allTime'].map(window=>({window,pnlHistory:[],accountValueHistory:[],from:null,to:null,pnl:null,volume:0}))}:
  {...venue,kind:'leaderboard',window:'month',ranking:'pnl',sourceAsOf:NOW,total:empty?0:1,rows:empty?[]:[{rank:1,address,pnl:42,roiPct:2,volume:70,accountValue:123}]};
 return {schema:'public-market-relay-v1',resource:'traders',receivedAt:NOW,body};
}
function assertTabs(html,active){
 const nav=html.match(/<nav class="dc-section-nav"[^>]*>(.*?)<\/nav>/s)?.[1];
 assert.ok(nav);
 const links=[...nav.matchAll(/<a class="([^"]*)" href="([^"]+)">([^<]+)<\/a>/g)];
 assert.deepEqual(links.map(([,cls,href])=>[cls,href]),[[active==='social'?'selected':'','?page=social'],[active==='traders'?'selected':'','?page=social&view=rank']]);
 assert.match(links[0][3],/^(社媒动向|Social trends)$/);
 assert.match(links[1][3],/^(交易员排行|Trader leaderboard)$/);
 assert.doesNotMatch(html,/page=intelligence|新闻与社媒|News and social|mastodon|social-sample/i);
}
function harness(t,{body=curated(),fetchImpl,search='?page=social&social_feed=featured'}={}){
 const names=['document','window','location','navigator'],old=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 const doc={hidden:false,activeElement:null,addEventListener(){},querySelector(){return null;}},win=new EventTarget(),loc={search};
 for(const [name,value]of Object.entries({document:doc,window:win,location:loc,navigator:{onLine:true}}))Object.defineProperty(globalThis,name,{configurable:true,value});
 let at=NOW,html='',page='social',view,refreshButton;
 const calls=[],root={scrollTop:0,contains(){return false;},querySelector(selector){return selector==='[data-dc-live-refresh]'?refreshButton:null;},querySelectorAll(){return [];}};
 const render=()=>{
  html=view.render(page);refreshButton=html?.includes('data-dc-live-refresh')?new EventTarget():null;view.bind();return html;
 };
 view=createLiveDataViews({root,now:()=>at,rerender:render,link:(label,target,params={},cls='')=>`<a class="${cls}" href="?${new URLSearchParams({page:target,...params})}">${label}</a>`,section:(title,content,action='')=>`<section><h2>${title}</h2>${action}${content}</section>`,table:(_heads,rows)=>rows.join(''),stat:(_label,value)=>value+' ',chartPanel:()=>'',empty:text=>`<p>${text}</p>`,fetchImpl:(url,init)=>{calls.push({url,init});return fetchImpl?fetchImpl(url,init):Promise.resolve(Response.json(body));}});
 t.after(()=>{win.dispatchEvent(new Event('pagehide'));for(const [name,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
 return {view,calls,get html(){return html;},render,goto(search,nextPage='social'){loc.search=search;page=nextPage;return render();},refresh(){assert.ok(refreshButton);refreshButton.dispatchEvent(new Event('click'));},setNow(value){at=value;}};
}

test('activity defaults to recent discovery and can switch to featured without relabeling the feed',async t=>{
 assert.equal(liveDataRoute('social','').query.feed,'recent');
 assert.equal(liveDataRoute('social','social_feed=featured').query.feed,'featured');
 const h=harness(t,{search:'?page=social',fetchImpl:async url=>Response.json(new URL(url,'https://example.test').searchParams.get('feed')==='featured'?curated():recent())});
 h.render();await settle();assert.match(h.html,/RECENT_CRYPTO_POST/);assert.doesNotMatch(h.html,/50,000|QUALIFIED_CREATOR_POST/);
 assert.match(h.html,/cryptocurrencies|加密市场/);
 h.goto('?page=social&social_feed=featured');await settle();assert.match(h.html,/QUALIFIED_CREATOR_POST/);assert.match(h.html,/50,000/);assert.doesNotMatch(h.html,/RECENT_CRYPTO_POST/);
});

test('every live activity alias reads the curated LunarCrush route while ranking and addresses retain their own meaning',()=>{
 const home=liveDataRoute('social','');
 assert.equal(home.resource,'social');assert.equal(home.stale,HOUR);
 for(const search of ['view=posts','view=mastodon','view=动态','view=全部动态','asset=BTC']){
  assert.deepEqual(liveDataRoute('social',search),home);
  assert.equal(liveDataRoute('social','data=demo&'+search),null);
 }
 for(const view of ['rank','排行榜','发现交易员','交易员排行'])assert.equal(liveDataRoute('social','view='+view).resource,'traders');
 const trader=liveDataRoute('social','view=posts&trader='+address.toUpperCase());
 assert.equal(trader.resource,'traders');assert.deepEqual(trader.query,{address});
 for(const invalid of ['orbit',''])assert.equal(liveDataRoute('social','trader='+invalid).resource,null);
});
test('curated route validates its exact feed and preserves observed time and one-hour source expiry',()=>{
 const route=liveDataRoute('social','view=posts&social_feed=featured'),receipt=validateLiveDataResponse(curated(),route,NOW);
 assert.equal(receipt.receivedAt,NOW);assert.equal(receipt.validUntil,NOW+HOUR);assert.equal(receipt.asOf,NOW);
 for(const bad of [mastodon(),{...curated(),mode:'offline_fixture'},{...curated(),as_of_ms:NOW+61000},{...curated(),as_of_ms:NOW-1}])assert.throws(()=>validateLiveDataResponse(bad,route,NOW));
});
test('actual activity renderer reuses the curated creator cards, criteria, links and publication time',async t=>{
 const h=harness(t);h.render();await settle();assert.equal(new URL(h.calls[0].url,'https://astarter.imstark.site').searchParams.get('resource'),'social');
 assert.match(h.html,/<header class="pd-kol-heading"><h2>(?:社媒动向|Social trends)<\/h2>/);assert.match(h.html,/QUALIFIED_CREATOR_POST &lt;img&gt;/);assert.match(h.html,/654,321/);assert.match(h.html,/BTC · #17/);assert.match(h.html,/50,000/);
 assert.match(h.html,/href="https:\/\/www.youtube.com\/channel\/UC-example"/);assert.match(h.html,/href="https:\/\/www.youtube.com\/watch\?v=clip-id"/);assert.match(h.html,/2026-11-18T05:59:00\.000Z/);
 assert.match(h.html,/data-social-post=[\s\S]*data-lunar-topic=/);
 assertTabs(h.html,'social');assert.match(h.html,/LunarCrush/);assert.doesNotMatch(h.html,/Hyperliquid|<img>/);
});
test('partial creator evidence stays partial without removing successfully qualified posts',async t=>{
 const h=harness(t,{body:curated({partial:true})});h.render();await settle();assert.match(h.html,/data-quality="partial"/);assert.match(h.html,/Partially available|Partial data|部分可用/);assert.match(h.html,/QUALIFIED_CREATOR_POST/);assert.match(h.html,/SOL/);assert.match(h.html,/Creator ranking unavailable|作者榜单暂不可用/);
});
for(const verified of [true,false])test('empty curation distinguishes no qualifying creator from unverified creator evidence: '+verified,async t=>{
 const h=harness(t,{body:curated({qualified:false,verified})});h.render();await settle();assert.match(h.html,verified?/No qualifying posts|暂无符合条件/:/Creator verification unavailable|暂时无法核验/);assert.match(h.html,/data-lunar-topic="BTC"/);assert.doesNotMatch(h.html,/data-social-post=|Mastodon/);
});
test('failed or expired social refresh retains source time and cannot relabel old creator evidence as updated',async t=>{
 let calls=0;const h=harness(t,{fetchImpl:async()=>++calls===1?Response.json(curated()):new Response('{}',{status:503})});h.render();await settle();h.setNow(NOW+HOUR+1);h.view.tick('social');await settle();
 assert.match(h.html,/data-quality="stale"/);assert.match(h.html,/Source unavailable|来源暂不可用|Stale data|数据已过期/);assert.match(h.html,/QUALIFIED_CREATOR_POST/);assert.match(h.html,/2026-11-18T05:59:00\.000Z/);assert.doesNotMatch(h.html,/Mastodon/);
});
test('legacy and restored URLs, manual refresh, ranking and address detail fetch only their own relay resource',async t=>{
 const old='?page=social&view=mastodon&social_feed=featured',rank='?page=social&view=rank',profile='?page=social&trader='+address;
 const h=harness(t,{search:old,fetchImpl:async url=>{
  const q=new URL(url,'https://example.test').searchParams;
  return Response.json(q.get('resource')==='social'?curated():traderReceipt({profile:q.has('address')}));
 }});
 h.render();await settle();assertTabs(h.html,'social');assert.equal(h.view.companionBrief('social').href,'?page=social&social_feed=featured');
 h.goto('?page=social&view=posts&social_feed=featured');h.goto('?page=social&social_feed=featured');assert.equal(h.calls.length,1);
 h.refresh();await settle();
 h.goto(rank);await settle();assertTabs(h.html,'traders');assert.match(h.html,/Hyperliquid/);assert.ok(h.html.includes('href="'+profile+'"'));assert.doesNotMatch(h.html,/LunarCrush|QUALIFIED_CREATOR_POST/);
 assert.ok(h.html.includes('href="'+profile+'"><span class="dc-trader-mobile-rank">#1</span><span title="'+address+'">'));
 h.goto(profile);await settle();assertTabs(h.html,'traders');assert.match(h.html,/Public address performance|公开地址表现/);assert.ok(h.html.includes(address));assert.doesNotMatch(h.html,/LunarCrush/);
 h.refresh();await settle();
 h.goto(rank);await settle();assertTabs(h.html,'traders');
 h.goto(old);await settle();assertTabs(h.html,'social');assert.match(h.html,/QUALIFIED_CREATOR_POST/);assert.doesNotMatch(h.html,/Hyperliquid/);
 h.goto(rank);await settle();assertTabs(h.html,'traders');
 const feedUrl='/api/market-hub?resource=social&selection_version=0&limit=50&feed=featured',rankUrl='/api/market-hub?resource=traders',profileUrl=rankUrl+'&address='+address;
 assert.deepEqual(h.calls.map(call=>call.url),[feedUrl,feedUrl,rankUrl,profileUrl,profileUrl,rankUrl,feedUrl,rankUrl]);
});
test('wrong feeds, invalid addresses and a verified empty leaderboard keep the correct recovery links',async t=>{
 const responses=[mastodon(),curated(),traderReceipt({empty:true})];
 const h=harness(t,{fetchImpl:async()=>Response.json(responses.shift())});
 h.render();await settle();assertTabs(h.html,'social');assert.match(h.html,/Source unavailable|来源暂不可用/);assert.match(h.html,/LunarCrush/);assert.doesNotMatch(h.html,/WRONG_MASTODON_CHANNEL/);
 h.goto('?page=social&view=rank');await settle();assertTabs(h.html,'traders');assert.match(h.html,/Source unavailable|来源暂不可用/);assert.doesNotMatch(h.html,/LunarCrush|QUALIFIED_CREATOR_POST/);
 h.goto('?page=social&trader=orbit&view=history');assertTabs(h.html,'traders');assert.match(h.html,/Invalid public address|公开地址无效/);assert.match(h.html,/trader=orbit&view=history&data=demo/);assert.equal(h.calls.length,2);
 h.goto('?page=social&view=rank');await settle();assertTabs(h.html,'traders');assert.match(h.html,/No records in this range|当前范围暂无记录/);assert.match(h.html,/data-quality="fresh"/);
});
test('late responses from either tab cannot replace the active source',async t=>{
 const replies=[],h=harness(t,{fetchImpl:()=>new Promise(resolve=>replies.push(resolve))});
 h.render();h.goto('?page=social&view=rank');assert.equal(h.calls[0].init.signal.aborted,true);
 replies[0](Response.json(curated()));await settle();assertTabs(h.html,'traders');assert.match(h.html,/Hyperliquid/);assert.doesNotMatch(h.html,/QUALIFIED_CREATOR_POST|LunarCrush/);
 h.goto('?page=social&social_feed=featured');assert.equal(h.calls[1].init.signal.aborted,true);
 replies[1](Response.json(traderReceipt()));await settle();assertTabs(h.html,'social');assert.doesNotMatch(h.html,/Hyperliquid/);
 replies[2](Response.json(curated()));await settle();assertTabs(h.html,'social');assert.match(h.html,/QUALIFIED_CREATOR_POST/);
});
