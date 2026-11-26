import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as views from './public-data-views.mjs';
const fixture=JSON.parse(readFileSync(new URL('./test-fixtures/public-data-v1.json',import.meta.url),'utf8'));
const NOW=Date.UTC(2026,10,17,12),DAY=Date.UTC(2026,10,17),copy=structuredClone;
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function envelope(kind,selection=1){
 const b=copy(fixture.market_fresh.body),item=copy(fixture.news_item),social=kind==='social';
 Object.assign(item,{record_id:social?'mastodon:123':'news:123',subject_id:social?'123':'news:123',venue_or_chain:null,provider_id:social?'mastodon-tag-v1':'coindesk-rss-v1',quality:'fresh',event_time_ms:NOW-60000,received_at_ms:NOW,available_at_ms:NOW,valid_until_ms:NOW+(social?300000:60000)});
 item.data=social?{metric_kind:'PUBLIC_SOCIAL_POST',platform:'Mastodon',instance:'mastodon.social',post_id:'123',url:'https://mastodon.social/@alice/123',author:{acct:'alice@example.social',display_name:'Alice',url:'https://mastodon.social/@alice',bot:true},text:'PRIVATE_POST_TEXT_ONLY_UI Ethereum and Solana',truncated:false,published_at_ms:NOW-60000,edited_at_ms:null,observed_at_ms:NOW,symbols:['ETH','SOL'],likes:0,reposts:2,replies:0}:{news_id:'123',title:'Original news v4.2',summary:'DO_NOT_EXPORT_NEWS_SUMMARY',url:'https://www.coindesk.com/news/123',published_at_ms:NOW-60000,asset_ids:[],symbols:['ETH']};
 return {...b,selection_version:selection,mode:'live_readonly',quality:'fresh',as_of_ms:NOW-60000,requested_at_ms:NOW,coverage:{scope:social?'SOCIAL_TAG_SAMPLES':'NEWS_FEED',limit:20},sources:[{provider_id:item.provider_id,status:'OK',last_success_at_ms:NOW,reason_code:null,retry_after_seconds:null}],items:[item]};
}
const sentiment=()=>({schema:'public-market-relay-v1',resource:'sentiment',receivedAt:NOW,body:{data:[{timestamp:String(DAY/1000),value:'12'}]}});
function harness(t,{fetchImpl,search='?page=intelligence'}={}){
 const keys=['document','window','location','history','navigator','localStorage','requestAnimationFrame'],old=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 const doc=Object.assign(new EventTarget(),{hidden:false,body:{},activeElement:null,querySelector:()=>null}),win=new EventTarget(),calls=[];doc.activeElement=doc.body;
 const controls=new Map();let html='',at=NOW,page='intelligence',view;
 class Control extends EventTarget{constructor(data={}){super();this.dataset=data;this.value='';this.isConnected=true;this.selectionStart=this.selectionEnd=null;}focus(){doc.activeElement=this;}setSelectionRange(){}matches(){return false;}}
 const root={contains:()=>false,querySelector:s=>controls.get(s)||null,querySelectorAll:s=>s==='[data-pd-feed]'?[...controls.values()].filter(n=>n.dataset.pdFeed):s==='[data-pd-social-feed]'?[...controls.values()].filter(n=>n.dataset.pdSocialFeed):[]};
 function install(){controls.clear();for(const id of ['news','social'])if(html.includes(`data-pd-feed="${id}"`))controls.set(`[data-pd-feed="${id}"]`,new Control({pdFeed:id}));for(const id of ['recent','featured'])if(html.includes(`data-pd-social-feed="${id}"`))controls.set(`[data-pd-social-feed="${id}"]`,new Control({pdSocialFeed:id}));for(const id of ['refresh','limit','search'])controls.set(`[data-pd-${id}]`,new Control());controls.get('[data-pd-limit]').value='20';view.bind();}
 const location=new URL(search,'https://astarter.imstark.site/'),history={state:null,pushState(state,unused,url){this.state=state;location.href=url;}};
 const globals={document:doc,window:win,location,history,navigator:{onLine:true},localStorage:{getItem:()=>null,setItem(){}},requestAnimationFrame:fn=>{queueMicrotask(fn);return 1;}};
 for(const [k,value]of Object.entries(globals))Object.defineProperty(globalThis,k,{configurable:true,value});
 view=views.createPublicDataViews({root,now:()=>at,rerender(){html=view.render(page);install();},fetchImpl:async(input,init)=>{const u=new URL(input,'https://astarter.imstark.site');calls.push({url:u,init});return fetchImpl?fetchImpl(u,init):json(u.searchParams.get('resource')==='sentiment'?sentiment():envelope(u.searchParams.get('resource'),Number(u.searchParams.get('selection_version'))));}});
 t.after(()=>{view.dispose();for(const k of keys){const d=old.get(k);if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);}});
 return {view,doc,win,calls,get html(){return html;},render(){html=view.render(page);install();return html;},control:s=>controls.get(s),click(id){const b=controls.get(`[data-pd-feed="${id}"]`);assert.ok(b,'actual tab is rendered');b.dispatchEvent(new Event('click'));},setNow(v){at=v;}};
}
const settleUI=async()=>{await settle();await settle();};

test('a social permalink requests social immediately, tracks native tabs and reads same-page URL changes',async t=>{
 const h=harness(t,{search:'?page=intelligence&feed=social&lang=zh'});h.render();await settleUI();
 assert.match(h.html,/data-pd-feed="social"[^>]*aria-selected="true"/);assert.equal(h.calls.some(call=>call.url.searchParams.get('resource')==='news'),false);
 h.click('news');await settleUI();assert.equal(location.searchParams.get('feed'),null);assert.equal(location.searchParams.get('lang'),'zh');assert.match(h.html,/Original news v4/);
 h.click('social');await settleUI();assert.equal(location.searchParams.get('feed'),'social');assert.match(h.render(),/data-pd-feed="social"[^>]*aria-selected="true"/);
 location.search='?page=intelligence';h.render();await settleUI();assert.match(h.html,/data-pd-feed="news"[^>]*aria-selected="true"/);
});

test('a social parameter cannot turn an explicit demo into a live request',t=>{
 const h=harness(t,{search:'?page=intelligence&data=demo&feed=social'});assert.equal(h.view.render('intelligence'),null);h.view.tick('intelligence',1);assert.equal(h.calls.length,0);
});

test('news is the default native tab and social performs zero reads until explicitly selected',async t=>{
 const h=harness(t);h.render();await settleUI();assert.match(h.html,/role="tablist"/);assert.match(h.html,/data-pd-feed="news"[^>]*aria-selected="true"/);assert.equal(h.calls.filter(c=>c.url.searchParams.get('resource')==='social').length,0);assert.match(h.html,/Original news v4\.2/);assert.match(h.html,/<header class="df-page-head">[\s\S]*pd-feed-tabs[\s\S]*<main class="df-news-main">[\s\S]*df-economic-calendar[\s\S]*df-news-tools[\s\S]*df-timeline[\s\S]*<\/main><aside class="df-aside">[\s\S]*df-market-list[\s\S]*pd-sentiment/);
 h.click('social');await settleUI();assert.equal(h.calls.filter(c=>c.url.searchParams.get('resource')==='social').length,1);assert.match(h.html,/data-pd-feed="social"[^>]*aria-selected="true"/);assert.match(h.html,/PRIVATE_POST_TEXT_ONLY_UI/);assert.match(h.html,/Alternative\.me/);assert.equal(h.calls.filter(c=>c.url.searchParams.get('resource')==='sentiment').length,1);
});

test('social displays author, original time, zero counts, several asset logos and explicit sample scope',async t=>{
 const h=harness(t);h.render();await settleUI();h.click('social');await settleUI();const html=h.html;
 assert.match(html,/Alice/);assert.match(html,/alice@example\.social/);assert.match(html,/2026-11-17T11:59:00\.000Z/);assert.match(html,/https:\/\/mastodon\.social\/@alice\/123/);assert.match(html,/data-social-count="likes">0</);assert.match(html,/data-social-count="replies">0</);assert.match(html,/data-social-count="reposts">2</);assert.match(html,/自动账号|Automated account/);assert.match(html,/#bitcoin/);assert.match(html,/#ethereum/);assert.match(html,/#solana/);assert.match(html,/10/);assert.match(html,/公开标签样本|Public hashtag sample/);assert.match(html,/不是全网|Not network-wide/);
 const posts=views.publicSocialRecords(envelope('social').items);assert.match(posts,/crypto-icons\/eth\.svg/);assert.match(posts,/crypto-icons\/sol\.svg/);assert.doesNotMatch(posts,/crypto-icons\/btc\.svg/);
});

test('social source context and companion export only metadata, never the post text',async t=>{
 const h=harness(t);h.render();await settleUI();h.click('social');await settleUI();const source=h.view.sourceSnapshot(),body=JSON.parse(source.text),item=body.items[0];assert.equal(source.kind,'social');assert.equal(item.author.acct,'alice@example.social');assert.equal(item.likes,0);assert.equal(item.published_at_ms,NOW-60000);assert.doesNotMatch(source.text,/PRIVATE_POST_TEXT|Ethereum and Solana/);assert.doesNotMatch(JSON.stringify(h.view.companionBrief()),/PRIVATE_POST_TEXT|Ethereum and Solana/);
});

test('social rendering escapes text and authors and rejects unsafe original/profile links without rendering media',()=>{
 const item=envelope('social').items[0];Object.assign(item.data,{text:'<img src=x onerror=alert(1)>',url:'javascript:alert(1)',symbols:['ETH','ETH','UNKNOWN']});Object.assign(item.data.author,{display_name:'<svg onload=alert(2)>',acct:'<script>bad</script>',url:'https://user:password@example.test'});
 const html=views.publicSocialRecords([item]);assert.match(html,/&lt;img/);assert.match(html,/&lt;svg/);assert.doesNotMatch(html,/<img src=x|<svg onload|<script>|href="javascript|password|UNKNOWN/);assert.equal((html.match(/crypto-icons\/eth\.svg/g)||[]).length,1);
});

test('failed social refresh retains old posts as stale and preserves the original publication time',async t=>{
 let reads=0;const h=harness(t,{fetchImpl:async u=>u.searchParams.get('resource')==='sentiment'?json(sentiment()):u.searchParams.get('resource')==='social'&&++reads>1?json({error:'PRIVATE_ERROR'},503):json(envelope(u.searchParams.get('resource'),Number(u.searchParams.get('selection_version'))))});
 h.render();await settleUI();h.click('social');await settleUI();h.setNow(NOW+61000);h.view.tick('intelligence',1);await settleUI();assert.match(h.html,/PRIVATE_POST_TEXT_ONLY_UI/);assert.match(h.html,/已过期|Stale|marked stale/);assert.match(h.html,/2026-11-17T11:59:00\.000Z/);assert.doesNotMatch(h.html,/PRIVATE_ERROR/);
});

test('a successful empty social sample differs from an unavailable source',async t=>{
 const h=harness(t,{fetchImpl:async u=>{if(u.searchParams.get('resource')==='sentiment')return json(sentiment());const b=envelope(u.searchParams.get('resource'),Number(u.searchParams.get('selection_version')));if(u.searchParams.get('resource')==='social')b.items=[];return json(b);}});h.render();await settleUI();h.click('social');await settleUI();assert.match(h.html,/暂无公开帖子|No public posts/);assert.doesNotMatch(h.html,/服务暂未连接|Data service is unavailable/);
});

test('hidden social requests abort and their late replies do not create a visible or exported sample',async t=>{
 let finish,signal;const h=harness(t,{fetchImpl:(u,init)=>u.searchParams.get('resource')==='social'?new Promise(resolve=>{signal=init.signal;finish=()=>resolve(json(envelope('social',Number(u.searchParams.get('selection_version')))));}):json(u.searchParams.get('resource')==='sentiment'?sentiment():envelope('news',Number(u.searchParams.get('selection_version'))))});h.render();await settleUI();h.click('social');await settle();assert.equal(signal.aborted,false);h.doc.hidden=true;h.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(signal.aborted,true);finish();await settleUI();assert.equal(h.view.sourceSnapshot(),null);assert.doesNotMatch(h.html,/PRIVATE_POST_TEXT_ONLY_UI/);
});

test('switching to news aborts the old social read and ignores its late response',async t=>{
 let finish,signal;const h=harness(t,{fetchImpl:(u,init)=>u.searchParams.get('resource')==='social'?new Promise(resolve=>{signal=init.signal;finish=()=>resolve(json(envelope('social',Number(u.searchParams.get('selection_version')))));}):json(u.searchParams.get('resource')==='sentiment'?sentiment():envelope('news',Number(u.searchParams.get('selection_version'))))});h.render();await settleUI();h.click('social');await settle();h.click('news');assert.equal(signal.aborted,true);finish();await settleUI();assert.match(h.html,/Original news v4\.2/);assert.doesNotMatch(h.html,/PRIVATE_POST_TEXT_ONLY_UI/);assert.equal(h.view.sourceSnapshot().kind,'news');
});

test('social uses shared search, explicit limit changes and refresh, with no implicit POST or model request',async t=>{
 const h=harness(t);h.render();await settleUI();h.click('social');await settleUI();let input=h.control('[data-pd-search]');input.value='does not match';input.dispatchEvent(new Event('input'));await settleUI();assert.match(h.html,/没有匹配|No matching/);input=h.control('[data-pd-search]');input.value='';input.dispatchEvent(new Event('input'));await settleUI();assert.match(h.html,/PRIVATE_POST_TEXT_ONLY_UI/);
 const select=h.control('[data-pd-limit]');select.value='50';select.dispatchEvent(new Event('change'));await settleUI();assert.ok(h.calls.some(c=>c.url.searchParams.get('resource')==='social'&&c.url.searchParams.get('limit')==='50'));
 const before=h.calls.filter(c=>c.url.searchParams.get('resource')==='social').length;h.control('[data-pd-refresh]').dispatchEvent(new Event('click'));await settleUI();assert.equal(h.calls.filter(c=>c.url.searchParams.get('resource')==='social').length,before+1);
 assert.ok(h.calls.every(c=>(c.init.method??'GET')==='GET'));assert.ok(h.calls.every(c=>['news','social','sentiment','macro','cross-candles'].includes(c.url.searchParams.get('resource'))));
});

test('unavailable social keeps FNG independent and never uses posts or bot false as a verified-human claim',async t=>{
 const h=harness(t,{fetchImpl:async u=>u.searchParams.get('resource')==='social'?json({error:'PRIVATE_DETAIL'},503):json(u.searchParams.get('resource')==='sentiment'?sentiment():envelope('news',Number(u.searchParams.get('selection_version'))))});h.render();await settleUI();h.click('social');await settleUI();assert.match(h.html,/data-fng-value>12<\/strong>/);assert.match(h.html,/暂无可用|更新失败|Update failed/);assert.equal(h.view.sourceSnapshot(),null);assert.doesNotMatch(h.html,/PRIVATE_DETAIL|PRIVATE_POST_TEXT_ONLY_UI/);
 for(const bot of [false,null]){const item=envelope('social').items[0];item.data.author.bot=bot;assert.doesNotMatch(views.publicSocialRecords([item]),/Automated account|自动账号|真人|Verified human/);}
});

function lunarEnvelope(selection,{posts=true}={}){
 const body=envelope('social',selection),item=body.items[0];body.coverage={scope:'LUNARCRUSH_TOPICS',observed_at_ms:NOW,topics:[{symbol:'BTC',topic:'bitcoin',asOf:null,posts24h:0,contributors24h:null,interactions24h:1234,sentimentByNetwork:{X:0,Reddit:77}}],errors:posts?[]:[{symbol:'BTC',resource:'posts',code:'FORBIDDEN'}]};
 body.sources[0].provider_id=item.provider_id='lunarcrush-v4';item.valid_until_ms=NOW+3600000;
 item.data={metric_kind:'LUNARCRUSH_POST',post_id:'x-123',platform:'X',text:'ORIGINAL_LUNAR_POST <img>',url:'https://x.com/example/status/123',author:{acct:null,display_name:null,url:null,bot:null},symbols:['BTC'],published_at_ms:item.event_time_ms,observed_at_ms:NOW,interactions_24h:0};
 if(!posts){body.items=[];body.quality='partial';}return body;
}

test('LunarCrush shows platform-specific sentiment, real engagement and no invented authors or interaction types',async t=>{
 const h=harness(t,{fetchImpl:async u=>{const kind=u.searchParams.get('resource'),selection=Number(u.searchParams.get('selection_version'));return json(kind==='sentiment'?sentiment():kind==='social'?lunarEnvelope(selection):envelope(kind,selection));}});
 h.render();await settleUI();h.click('social');await settleUI();
 assert.match(h.html,/data-lunar-topic="BTC"/);assert.match(h.html,/X 0 · Reddit 77/);assert.match(h.html,/title="0">0<\/dd>/);assert.match(h.html,/<dd>—<\/dd>/);assert.match(h.html,/LunarCrush/);assert.match(h.html,/data-social-count="interactions_24h">0</);assert.match(h.html,/href="https:\/\/x.com\/example\/status\/123"/);
 assert.match(h.html,/ORIGINAL_LUNAR_POST &lt;img&gt;/);assert.doesNotMatch(h.html,/Mastodon|data-social-count="(?:likes|reposts|replies)"|@null|>null</);
 const metadata=JSON.parse(h.view.sourceSnapshot().text);assert.equal(metadata.items[0].interactions_24h,0);assert.equal(metadata.items[0].author.acct,null);assert.doesNotMatch(h.view.sourceSnapshot().text,/ORIGINAL_LUNAR_POST/);assert.equal(h.view.companionBrief().title,'X');assert.match(h.view.companionBrief().source,/LunarCrush/);
});

test('LunarCrush aggregate-only access keeps topic evidence and explains missing posts',async t=>{
 const h=harness(t,{fetchImpl:async u=>{const kind=u.searchParams.get('resource'),selection=Number(u.searchParams.get('selection_version'));return json(kind==='sentiment'?sentiment():kind==='social'?lunarEnvelope(selection,{posts:false}):envelope(kind,selection));}});
 h.render();await settleUI();h.click('social');await settleUI();assert.match(h.html,/原帖暂不可用|Posts unavailable/);assert.match(h.html,/data-lunar-topic="BTC"/);assert.doesNotMatch(h.html,/Mastodon|No public posts|暂无公开帖子/);assert.equal(h.view.companionBrief().title,'BTC');assert.equal(h.view.companionBrief().source,'LunarCrush');assert.equal(JSON.parse(h.view.sourceSnapshot().text).coverage.topics[0].interactions24h,1234);
});

function curatedEnvelope(selection,{verified=true,withPost=true}={}){
 const b=lunarEnvelope(selection);b.coverage.scope='LUNARCRUSH_KOL_TOPICS';
 b.coverage.curation={minFollowers:50000,maxTopicRank:100,minCreatorInteractions24h:1000,minDistinctPosts:2,maxPostsPerAuthor:1,rankedCreators:9,qualifiedCreators:verified&&withPost?1:0,checkedTopics:verified?['BTC','ETH','SOL']:[],failedTopics:verified?[]:['BTC','ETH','SOL']};
 if(verified&&withPost){
  Object.assign(b.items[0].data,{interactions_24h:485,platform:'YouTube',url:'https://www.youtube.com/watch?v=clip-id',author:{acct:'Creator Name',display_name:'Creator Name',url:null,bot:null},kol:{creatorId:'youtube::UC-example',followers:654321,topicRank:17,profileUrl:'https://www.youtube.com/channel/UC-example',creatorInteractions24h:17000,qualifyingPostCount:3,evidenceSymbol:'BTC'}});
 }else b.items=[];
 if(!verified){b.quality='partial';b.coverage.errors=['BTC','ETH','SOL'].map(symbol=>({symbol,resource:'creators',code:'UNAVAILABLE'}));}return b;
}
test('news social mode switches recent and featured with matching typed queries and original selection isolation',async t=>{
 const h=harness(t,{search:'?page=intelligence&feed=social',fetchImpl:async u=>{
  const kind=u.searchParams.get('resource'),selection=Number(u.searchParams.get('selection_version'));
  if(kind!=='social')return json(kind==='sentiment'?sentiment():envelope(kind,selection));
  if(u.searchParams.get('feed')!=='recent')return json(curatedEnvelope(selection));
  const body=lunarEnvelope(selection);Object.assign(body.coverage,{feed:'recent',discovery:{category:'cryptocurrencies',status:'OK'}});body.items[0].data.creator_id='twitter::123';body.items[0].data.text='RECENT_MODE_SOURCE_POST';return json(body);
 }});
 h.render();await settleUI();assert.match(h.html,/Creator Name/);
 h.control('[data-pd-social-feed="recent"]').dispatchEvent(new Event('click'));await settleUI();
 assert.equal(location.searchParams.get('social_feed'),'recent');assert.match(h.html,/RECENT_MODE_SOURCE_POST/);assert.doesNotMatch(h.html,/Creator Name/);
 assert.equal(h.calls.filter(c=>c.url.searchParams.get('resource')==='social').at(-1).url.searchParams.get('feed'),'recent');
 h.control('[data-pd-social-feed="featured"]').dispatchEvent(new Event('click'));await settleUI();assert.match(h.html,/Creator Name/);assert.doesNotMatch(h.html,/RECENT_MODE_SOURCE_POST/);
});
test('curated posts distinguish topic activity from verified creator reach and topic ranking',async t=>{
 const h=harness(t,{fetchImpl:async u=>{const kind=u.searchParams.get('resource'),sequence=Number(u.searchParams.get('selection_version'));return json(kind==='sentiment'?sentiment():kind==='social'?curatedEnvelope(sequence):envelope(kind,sequence));}});
 h.render();await settleUI();h.click('social');await settleUI();assert.match(h.html,/全量主题热度|Topic-wide activity/);assert.match(h.html,/精选 KOL|Featured creators/);assert.match(h.html,/654,321/);assert.match(h.html,/BTC · #17/);assert.match(h.html,/50,000/);assert.match(h.html,/href="https:\/\/www.youtube.com\/channel\/UC-example"/);assert.match(h.html,/href="https:\/\/www.youtube.com\/watch\?v=clip-id"/);assert.equal(h.view.companionBrief().title,'Creator Name');assert.equal(JSON.parse(h.view.sourceSnapshot().text).items[0].kol.qualifyingPostCount,3);
 const sampled=new Date(curatedEnvelope(1).coverage.observed_at_ms).toISOString();
 assert.ok(h.html.includes('<time datetime="'+sampled+'">'));
 assert.match(h.html,/class="pd-post-caption">1 (条 · 发布时间|posts · Published) UTC\+8/);
 const input=h.control('[data-pd-search]');input.value='no matching creator';input.dispatchEvent(new Event('input'));await settleUI();
 assert.match(h.html,/class="pd-post-caption">0 (条 · 发布时间|posts · Published) UTC\+8/);
});
for(const verified of [true,false])test('curation without a qualifying post: rankings checked = '+verified,async t=>{
 const h=harness(t,{fetchImpl:async u=>{const kind=u.searchParams.get('resource'),sequence=Number(u.searchParams.get('selection_version'));return json(kind==='sentiment'?sentiment():kind==='social'?curatedEnvelope(sequence,{verified,withPost:false}):envelope(kind,sequence));}});
 h.render();await settleUI();h.click('social');await settleUI();assert.match(h.html,verified?/暂无符合条件|No qualifying posts/:/暂时无法核验|Creator verification unavailable/);assert.doesNotMatch(h.html,/ORIGINAL_LUNAR_POST|data-social-post=/);assert.match(h.html,/data-lunar-topic="BTC"/);
});

test('native tab arrow navigation selects social once and disposal cannot revive it',async t=>{
 const h=harness(t);h.render();await settleUI();const key=new Event('keydown',{cancelable:true});Object.defineProperty(key,'key',{value:'ArrowRight'});h.control('[data-pd-feed="news"]').dispatchEvent(key);await settleUI();assert.equal(key.defaultPrevented,true);assert.match(h.html,/data-pd-feed="social"[^>]*aria-selected="true"/);assert.equal(h.calls.filter(c=>c.url.searchParams.get('resource')==='social').length,1);
 h.view.dispose();const count=h.calls.length;h.view.tick('intelligence',120);assert.equal(h.view.render('intelligence'),null);assert.equal(h.calls.length,count);
});

test('external social authors and posts keep their source wording in both supported feeds', () => {
 for(const item of [envelope('social').items[0],curatedEnvelope(1).items[0]]){
  item.data.text='让 Agent 接管任务';
  const html=views.publicSocialRecords([item]);
  assert.match(html,/<(?:header|div) class="pd-social-author" data-no-translate>/);
  assert.match(html,/<p class="pd-social-text" data-no-translate>让 Agent 接管任务/);
 }
});
