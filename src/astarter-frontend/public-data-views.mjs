import {socialMediaAttributes} from './public-social-media.mjs';
import {createPublicDataClient,currentPublicEnvelope,PUBLIC_ASSETS,PUBLIC_CHAINS,safePublicURL} from './public-data-client.mjs';
import {RECENT_SOCIAL_SCOPE,SOCIAL_PLATFORMS,SOCIAL_SYMBOLS,socialFiltersFromLocation} from './public-social-scope.mjs';
import {renderIntelligenceCalendar} from './intelligence-calendar.mjs';
import {renderIntelligenceNewsFeed,renderIntelligenceNewsAside,filterIntelligenceNews,newsBookmarkSnapshots,createNewsDeliveryReader} from './intelligence-news-feed.mjs';
import {createIntelligenceContext,renderIntelligenceMarkets} from './intelligence-context.mjs';
export {safePublicURL} from './public-data-client.mjs';
import {tokenIcon,venueIcon} from './brand-icons.mjs';
import {canAutoRefresh,bindSearchRender,dataRefreshControls,uiGlyph} from './product-composition.mjs';
import {L} from './execution-views.mjs';
import {HUB_REFRESH_SECONDS,parseHubRefreshSeconds,createMarketHubClient} from './market-hub-data.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={bitcoin:'Bitcoin',ethereum:'Ethereum',solana:'Solana'};
const providers={'binance-spot-ticker-v1':'Binance Spot','coingecko-assets-v1':'CoinGecko','coindesk-rss-v1':'CoinDesk','mastodon-tag-v1':'Mastodon','lunarcrush-v4':'LunarCrush','bluesky-latest-v1':'Bluesky','nostr-relay-v1':'Nostr · Primal',etherscan:'Etherscan V2','etherscan-v2':'Etherscan V2','publicnode-rpc':'PublicNode'};
const qualityLabel=q=>({fresh:L('已更新','Updated'),partial:L('部分可用','Partial data'),stale:L('数据已过期','Stale data'),unavailable:L('暂无可用数据','Data unavailable')})[q]||L('等待读取','Waiting');
const numeric=(value,digits=2)=>value===null||value===undefined?'—':Number(value).toLocaleString('en-US',{maximumFractionDigits:digits,minimumFractionDigits:Math.min(2,digits)});
const price=value=>value===null||value===undefined?'—':Number(value)>0&&Number(value)<1e-8?'<0.00000001':numeric(value,Number(value)<1?8:2);
const money=value=>value===null||value===undefined?'—':Number(value).toLocaleString('en-US',{notation:'compact',maximumFractionDigits:2});
const stamp=value=>value===null||value===undefined?'—':new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(value);
const feedDateTime=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const info=(text,label=L('查看说明','About this data'))=>`<details class="pd-info" data-persist-key="${esc(text)}"><summary aria-label="${esc(label)}">i</summary><div>${esc(text)}</div></details>`;
export function publicEmptyNewsConfirmed(state){const b=state.snapshot;return !!(b&&!state.error&&b.coverage.scope==='NEWS_FEED'&&b.as_of_ms!==null&&b.items.length===0&&b.quality==='fresh'&&b.sources.some(x=>x.status==='OK'));}
const href=(page,params={})=>'?'+new URLSearchParams({page,data:'live',...params});
const go=(label,page,params={},cls='')=>`<a class="${cls}" data-dc-link href="${esc(href(page,params))}">${label}</a>`;
const change=value=>value===null||value===undefined?'—':`<span class="${Number(value)>=0?'pd-up':'pd-down'}">${Number(value)>0?'+':''}${numeric(value)}%</span>`;
const sourceName=id=>id==='blockbeats-news-v1'?L('律动 BlockBeats','BlockBeats'):providers[id]||id;
const notice=(title,body,action='')=>`<div class="pd-empty"><strong>${esc(title)}</strong><p>${esc(body)}</p>${action}</div>`;

export function publicDataModebar(page,search=globalThis.location?.search||''){
 if(page==='intelligence')return '';
 if(page!=='markets')return ['tracking','social','derivatives','etf'].includes(page)&&new URLSearchParams(search).get('data')==='live'?`<div class="pd-modebar"><span>${L('本页为演示数据 · 只读服务尚未接入','Demo data on this page · Read-only service not connected')}</span></div>`:'';
 const p=new URLSearchParams(search),live=p.get('data')==='live';
 const link=(label,value,short=label)=>{const q=new URLSearchParams(p);q.set('page',page);q.set('data',value);return `<a data-dc-link href="?${esc(q.toString())}" aria-label="${esc(label)}" aria-current="${live===(value==='live')?'page':'false'}"><span class="pd-mode-full">${label}</span><span class="pd-mode-short">${short}</span></a>`;};
 return `<div class="pd-modebar"><nav aria-label="${L('数据来源','Data source')}">${link(L('只读数据','Read-only data'),'live',L('只读','Read-only'))}${link(L('演示','Demo'),'demo')}</nav><span>${info(L('只读数据来自独立数据服务，不会调用模型、消耗研究积分或下单。演示模式使用固定样本；两者不会互相补数据。','Read-only data comes from the data service. It does not invoke models, spend research credits or place orders. Demo mode uses separate local examples.'))}</span></div>`;
}

function publicStatusBadge(state){
 const b=state.snapshot;
 return `<span class="pd-quality" data-quality="${state.offline?'unavailable':b?.quality||'unavailable'}"><i></i>${state.offline?L('网络已断开','Network offline'):state.pending?L('正在读取','Loading'):state.error?state.error==='DATA_SERVICE_UNAVAILABLE'?L('暂时无法更新','Temporarily unavailable'):state.error==='DATA_ACCESS_DENIED'?L('此入口无法读取数据','Data access unavailable'):L('更新失败','Update failed'):qualityLabel(b?.quality)}</span>`;
}
export function publicDataStatus(state,formatTime=stamp,resource=''){
 const b=state.snapshot;
 const mode=b?.mode==='live_readonly'?L('实时只读','Live read-only'):b?.mode==='offline_fixture'?L('离线测试样本','Offline test fixture'):L('只读服务','Read-only service');
 return `<div class="pd-status" role="status"${resource?` data-pd-status="${esc(resource)}"`:''}>${publicStatusBadge(state)}<span>${mode}</span>${b?.as_of_ms!==null&&b?.as_of_ms!==undefined?`<time>${L('数据时间','Data as of')} ${formatTime(b.as_of_ms)} UTC+8</time>`:''}${state.error&&b?`<span>${L('保留上次数据，已标记过期','Showing the previous data, marked stale')}</span>`:''}</div>`;
}

export function publicSourceDetails(state){
 const b=state.snapshot;if(!b)return '';
 const multi=b.coverage.scope===RECENT_SOCIAL_SCOPE,lc=lunarCoverageOf(b.coverage);
 const scope=multi?L('Bluesky 最新搜索、Nostr 公开标签、LunarCrush 热门帖','Bluesky latest search, Nostr public tags and LunarCrush top posts'):curatedScope(b.coverage)?L('主题统计与精选作者','Topic metrics and featured creators'):b.coverage.feed==='recent'?L('BTC / ETH / SOL 与加密市场原帖','BTC / ETH / SOL and crypto-market posts'):lunarScope(b.coverage)?L('LunarCrush 主题与原帖','LunarCrush topics and posts'):b.coverage.scope==='SOCIAL_TAG_SAMPLES'?L('公开标签样本','Public hashtag sample'):b.coverage.scope||'—';
 const gaps=(lc?.errors||[]).map(({symbol,resource})=>esc(symbol)+' · '+(['posts','category-posts'].includes(resource)?L('原帖暂不可用','Posts unavailable'):resource==='topic'?L('主题统计暂不可用','Topic metrics unavailable'):L('作者榜单暂不可用','Creator ranking unavailable')));
 if(multi&&b.coverage.bluesky_failed_symbols.length)gaps.push('Bluesky · '+esc(b.coverage.bluesky_failed_symbols.join(' / '))+' '+L('暂未读到','unavailable'));
 return `<details class="pd-sources"><summary>${L('来源与覆盖范围','Sources and coverage')}</summary><div class="pd-source-body"><dl><div><dt>${L('范围','Scope')}</dt><dd>${esc(scope)}</dd></div><div><dt>${L('当前读取','Requested')}</dt><dd>${stamp(b.requested_at_ms)} UTC+8</dd></div></dl>${b.sources.map(s=>`<p><b>${esc(sourceName(s.provider_id))}</b><span>${esc(s.reason_code==='ENTITLEMENT_REQUIRED'?L('此项需额外套餐','Additional plan required'):s.status==='OK'?L('读取成功','Read succeeded'):s.status==='STALE'?L('保留过期数据','Stale data retained'):s.status==='UNCONFIGURED'?L('尚未配置','Not configured'):L('暂不可用','Unavailable'))}</span><time>${stamp(s.last_success_at_ms)}</time></p>`).join('')}${gaps.length?`<div>${gaps.join(' · ')}</div>`:''}${!multi&&b.missing_capabilities.length?`<div>${L('尚未覆盖','Not covered')}: ${b.missing_capabilities.map(esc).join(' · ')}</div>`:''}</div></details>`;
}

export function publicMarketRows(state,assetState,{query=''}={}){
 const b=state.snapshot;if(!b?.items.length)return '';
 const assets=new Map((assetState.snapshot?.items||[]).map(i=>[i.subject_id,i]));
 const items=b.items.filter(i=>`${PUBLIC_ASSETS[i.subject_id]} ${names[i.subject_id]}`.toLowerCase().includes(query.trim().toLowerCase()));
 if(!items.length)return notice(L('没有匹配的资产','No matching assets'),L('目前只接入 BTC、ETH、SOL，可尝试搜索这三个资产。','BTC, ETH and SOL are covered in this release.'));
 return `<div class="pd-market-table" role="table" aria-label="${L('只读现货行情','Read-only spot markets')}"><div class="pd-market-tr pd-table-head" role="row"><span>${L('资产','Asset')}</span><span>${L('最新价格 / USDT','Last / USDT')}</span><span>24h %</span><span>${L('24h 成交额 / USDT','24h volume / USDT')}</span><span>${L('源时间','Source time')}</span></div>${items.map(i=>{const d=i.data,a=assets.get(i.subject_id)?.data;return `<a role="row" class="pd-market-tr" data-dc-link href="${href('markets',{asset:PUBLIC_ASSETS[i.subject_id]})}"><span role="cell" class="pd-asset">${tokenIcon({...a,asset_id:i.subject_id,symbol:d.instrument.base_asset},{size:32})}<span><strong>${d.instrument.base_asset}${i.quality!=='fresh'?`<em class="pd-row-quality">${qualityLabel(i.quality)}</em>`:''}</strong><small>${esc(a?.name||names[i.subject_id])} · Binance Spot</small></span></span><strong role="cell" class="pd-price" title="${esc(d.last_price)}">${esc(price(d.last_price))}</strong><span role="cell">${change(d.price_change_pct)}</span><span role="cell" class="pd-volume">${money(d.quote_volume)}</span><span role="cell" class="pd-time"><time>${stamp(i.event_time_ms)}</time><small>${qualityLabel(i.quality)}</small></span></a>`;}).join('')}</div>`;
}

export function publicCapabilityView(state,chain){
 const rows=state.snapshot?.items||[];
 const live=state.snapshot?.coverage?.scope==='LIVE_EXPLORER_CAPABILITIES';
 const cards=rows.map(({data:d,quality})=>{
  const abi=d.capability_id==='contract.abi',fallback=d.block_provider==='publicnode';
  const stateText=d.verification_state==='UNTESTED'?L('尚未测试','Not tested'):d.reason_code==='ENTITLEMENT_REQUIRED'?L('需额外套餐','Additional plan required'):d.status==='OK'?L('已测可用','Verified available'):d.status==='RATE_LIMITED'?L('来源限流','Rate limited'):L('暂不可用','Unavailable');
  const value=abi&&d.abi_function_count!=null?'Multicall3 · '+d.abi_function_count+' '+L('个函数','functions'):!abi&&d.block_height!=null?'#'+d.block_height.toLocaleString('en-US'):null;
  const source=fallback?'PublicNode':'Etherscan V2';
  return `<div><strong>${abi?L('合约 ABI 读取','Contract ABI'):L('最新区块','Latest block')}</strong><span>${esc(value||stateText)}</span><small>${esc(PUBLIC_CHAINS[d.chain_id])} · ${value?source+' · ':''}${stamp(d.verified_at_ms)}${quality==='stale'?' · '+L('已过期','Stale'):''}</small>${fallback?`<small>Etherscan · ${esc(stateText)}</small>`:''}</div>`;
 }).join('');
 return `<section class="pd-capabilities"><header><h2>${L('链上服务','Chain services')}</h2><label>${L('网络','Network')}<select data-pd-chain aria-label="${L('选择网络','Select network')}">${Object.entries(PUBLIC_CHAINS).map(([id,name])=>`<option value="${id}" ${chain===id?'selected':''}>${name}</option>`).join('')}</select></label></header><div class="pd-status"><span>${live?L('区块观测 · 每 45 秒刷新','Block observations · 45 s refresh'):L('能力登记','Capability register')}</span>${state.snapshot?.mode==='offline_fixture'?`<span>${L('离线测试样本','Offline test fixture')}</span>`:''}</div>${cards?`<div class="pd-capability-grid">${cards}</div>`:notice(state.pending?L('正在读取链上服务','Loading chain services'):L('暂无能力记录','No capability records'),'')}</section>`;
}

const newsAssets=new Set(['BTC','ETH','SOL','SPX','NDX','DXY','US10Y','XAU']);
const newsSymbols=data=>[...new Set([...(Array.isArray(data.symbols)?data.symbols:[]),...(Array.isArray(data.asset_ids)?data.asset_ids:[]).map(id=>PUBLIC_ASSETS[id])])].filter(symbol=>newsAssets.has(symbol));
const newsContext=item=>({provider:sourceName(item.provider_id),quality:item.quality,title:item.data.title,url:safePublicURL(item.data.url),published_at_ms:item.data.published_at_ms,symbols:newsSymbols(item.data)});
export function publicNewsRecords(items){return items.map(i=>{const d=i.data,url=safePublicURL(d.url);return `<article><div class="pd-news-time"><time datetime="${new Date(d.published_at_ms).toISOString()}">${feedDateTime.format(d.published_at_ms)}</time><small>${qualityLabel(i.quality)}</small></div><div><h2 data-no-translate>${esc(d.title)}</h2><footer><span>${esc(sourceName(i.provider_id))}</span>${newsSymbols(d).map(symbol=>{const label=`${tokenIcon(symbol,{size:16})}<span>${symbol}</span>`;return ['BTC','ETH','SOL'].includes(symbol)?go(label,'markets',{asset:symbol},'pd-news-asset'):`<span class="pd-news-asset">${label}</span>`;}).join('')}${url?`<a class="pd-news-source" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${L('原文','Source')} ↗</a>`:''}</footer></div></article>`;}).join('');}

const socialSymbols=data=>[...new Set(Array.isArray(data.symbols)?data.symbols:[])].filter(symbol=>SOCIAL_SYMBOLS.includes(symbol));
const socialAssetTags=data=>socialSymbols(data).map(symbol=>{
 const label=`${tokenIcon(symbol,{size:16})}<span>${symbol}</span>`;
 return ['BTC','ETH','SOL'].includes(symbol)?go(label,'markets',{asset:symbol},'pd-news-asset'):`<span class="pd-news-asset">${label}</span>`;
}).join('');
const socialCount=value=>Number.isSafeInteger(value)&&value>=0?value:'—';
const lunarPost=item=>item.provider_id==='lunarcrush-v4';
const curatedScope=coverage=>coverage?.scope==='LUNARCRUSH_KOL_TOPICS';
const lunarScope=coverage=>curatedScope(coverage)||coverage?.scope==='LUNARCRUSH_TOPICS';
const lunarCoverageOf=coverage=>coverage?.scope===RECENT_SOCIAL_SCOPE?coverage.lunar:lunarScope(coverage)?coverage:null;
const visibleItems=snapshot=>curatedScope(snapshot?.coverage)?snapshot.items.filter(item=>item.data.kol&&snapshot.coverage.curation?.checkedTopics.includes(item.data.kol.evidenceSymbol)):snapshot?.items||[];
const whole=value=>Number.isSafeInteger(value)?value.toLocaleString('en-US'):'—';
function kolHeading(coverage,count,title=L('精选 KOL','Featured creators')){
 const rule=coverage.curation;if(!rule)return '';
 const showCount=count>0||(rule.checkedTopics.length>0&&!coverage.errors?.some(row=>row.resource==='posts'));
 return `<header class="pd-kol-heading"><h2>${esc(title)}</h2>${showCount?`<span class="pd-post-caption">${count} ${L('条 · 发布时间','posts · Published')} UTC+8</span>`:''}<details data-persist-key="lunar-kol-selection"><summary>${L('筛选依据','Selection criteria')}</summary><p>${L('粉丝至少','Followers ≥')} ${whole(rule.minFollowers)} · ${L('主题排名前','Topic rank ≤')} ${whole(rule.maxTopicRank)} · ${L('作者 24h 互动至少','24h creator interactions ≥')} ${whole(rule.minCreatorInteractions24h)} · ${L('不同原帖至少','Distinct posts ≥')} ${whole(rule.minDistinctPosts)} · ${L('每位作者最多展示','Posts per creator ≤')} ${whole(rule.maxPostsPerAuthor)}。</p><p>${L('核对作者','Creators checked')} ${whole(rule.rankedCreators)} · ${L('符合条件','Qualified')} ${whole(rule.qualifiedCreators)}</p><p>LunarCrush · ${esc(rule.checkedTopics.join(' / ')||'—')}${rule.failedTopics.length?' · '+esc(rule.failedTopics.join(' / '))+' '+L('未能核验','not verified'):''}</p></details></header>`;
}
const networkName=value=>value==='News'?L('新闻媒体','News'):value;
function lunarTopics(coverage){
 coverage=lunarCoverageOf(coverage);
 if(!coverage?.topics?.length)return '';
 const sampled=coverage.observed_at_ms;
 const sampleTime=Number.isSafeInteger(sampled)&&sampled>0?`<time datetime="${new Date(sampled).toISOString()}">${L('采样','Sampled')} ${feedDateTime.format(sampled).slice(0,16)} UTC+8</time>`:'';
 const metric=(label,value)=>`<div><dt>${label}</dt><dd${Number.isSafeInteger(value)?` title="${value}"`:''}>${value==null?'—':money(value)}</dd></div>`;
 return `<section class="pd-lunar-topics"><h2>${curatedScope(coverage)?L('全量主题热度','Topic-wide activity'):L('社媒热度','Social activity')} <span>LunarCrush · 24h</span></h2>${sampleTime}<div class="pd-lunar-grid">${coverage.topics.map(topic=>{
  const scores=Object.entries(topic.sentimentByNetwork||{});
  return `<article data-lunar-topic="${esc(topic.symbol)}"><header>${tokenIcon(topic.symbol,{size:20})}<strong>${esc(topic.symbol)}</strong>${topic.asOf!=null?`<time datetime="${new Date(topic.asOf).toISOString()}">${stamp(topic.asOf)} UTC+8</time>`:''}</header><dl>${metric(L('提及','Posts'),topic.posts24h)}${metric(L('贡献者','Contributors'),topic.contributors24h)}${metric(L('互动','Interactions'),topic.interactions24h)}</dl>${scores.length?`<details><summary>${L('各平台情绪','Sentiment by platform')} <span>${scores.slice(0,2).map(([name,value])=>esc(networkName(name))+' '+esc(value)).join(' · ')}</span></summary><ul aria-label="${L('情绪分（0 至 100）','Sentiment scores (0 to 100)')}">${scores.map(([network,score])=>`<li><span>${esc(networkName(network))}</span><b>${esc(score)}</b></li>`).join('')}</ul></details>`:''}</article>`;
 }).join('')}</div></section>`;
}
const socialContext=item=>{const d=item.data,a=d.author||{};return {...(lunarPost(item)?{interactions_24h:d.interactions_24h,...(d.kol?{kol:d.kol}:{})}:{likes:d.likes,reposts:d.reposts,replies:d.replies}),provider:sourceName(item.provider_id),quality:item.quality,platform:d.platform,instance:d.instance,post_id:d.post_id,url:safePublicURL(d.url),author:{acct:a.acct,display_name:a.display_name,url:safePublicURL(a.url),bot:a.bot},published_at_ms:d.published_at_ms,edited_at_ms:d.edited_at_ms,observed_at_ms:d.observed_at_ms,symbols:socialSymbols(d)};};
export function publicSocialRecords(items){return items.map(item=>{
 const d=item.data,a=d.author||{},url=safePublicURL(d.url),profile=safePublicURL(a.url),author=esc(a.display_name||a.acct||L('公开账号','Public account'));
 const direct=d.metric_kind==='SOCIAL_ORIGINAL_POST';
 if(lunarPost(item)||direct){
  const name=a.display_name||a.acct||d.kol?.creatorId||d.platform;
  const media=socialMediaAttributes(item),creator=safePublicURL(d.kol?.profileUrl)||profile;
  const handle=media||d.platform==='Bluesky'&&a.acct!==name?`<span class="pd-post-handle">@${esc(a.acct)}</span>`:'';
  const identity=`<strong>${esc(name)}</strong>${handle}`;
  const avatar=`<span class="pd-post-avatar" data-social-avatar aria-hidden="true">${esc(d.platform==='Nostr'?'N':Array.from(name.trim())[0]?.toUpperCase()||'·')}</span>`;
  const published=feedDateTime.format(d.published_at_ms);
  const time=`<time datetime="${new Date(d.published_at_ms).toISOString()}" title="${published} UTC+8"><span>${published.slice(0,10)}</span> ${published.slice(11,16)}</time>`;
  const byline=d.kol?`<div class="pd-kol-evidence"><span>${whole(d.kol.followers)} ${L('粉丝','followers')}</span><span>${esc(d.kol.evidenceSymbol)} · #${whole(d.kol.topicRank)}</span></div>`:'';
  const interactions=direct?[[L('赞','Likes'),d.likes],[L('转发','Reposts'),d.reposts],[L('回复','Replies'),d.replies]]
   .filter(([,count])=>Number.isSafeInteger(count)&&count>0).map(([label,count])=>`<span>${label} <b>${whole(count)}</b></span>`).join('')
   :`<span>${L('24h 互动','24h interactions')} <b data-social-count="interactions_24h">${whole(d.interactions_24h)}</b></span>`;
  return `<article class="pd-kol-post" data-social-post="${esc(d.post_id)}"${media}>
   <header class="pd-post-byline">
    ${creator?`<a class="pd-avatar-link" href="${esc(creator)}" rel="noopener noreferrer" target="_blank" tabindex="-1" aria-hidden="true">${avatar}</a>`:avatar}
    <div class="pd-post-identity"><div class="pd-social-author" data-no-translate>${creator?`<a class="pd-kol-profile" href="${esc(creator)}" rel="noopener noreferrer" target="_blank">${identity}</a>`:identity}</div>${byline}</div>
    <div class="pd-post-dateline">${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(d.platform)} · ${published} UTC+8">${time}<span class="pd-post-network">${media?'𝕏':esc(d.platform)} ↗</span></a>`:time}</div>
   </header>
   <p class="pd-social-text" data-no-translate>${esc(d.text)}</p>
   <div class="pd-post-media" data-social-photos hidden></div>
   <footer>${interactions}${socialAssetTags(d)}${direct&&item.quality==='stale'?`<span class="pd-row-quality">${L('上次读取','Last read')}</span>`:''}${url?`<a class="pd-news-source" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${L('原帖','Original post')} ↗</a>`:''}</footer>
  </article>`;
 }
 return `<article data-social-post="${esc(d.post_id)}"><div class="pd-news-time"><time datetime="${new Date(d.published_at_ms).toISOString()}">${feedDateTime.format(d.published_at_ms)}</time><small>${qualityLabel(item.quality)}</small></div><div><header class="pd-social-author" data-no-translate>${profile?`<a href="${esc(profile)}" target="_blank" rel="noopener noreferrer">${author}</a>`:`<strong>${author}</strong>`}<span>@${esc(a.acct)}</span>${a.bot===true?`<span class="pd-social-bot">${L('自动账号','Automated account')}</span>`:''}</header><p class="pd-social-text" data-no-translate>${esc(d.text)}${d.truncated?`<span class="pd-social-truncated"> · ${L('节选','Excerpt')}</span>`:''}</p><div class="pd-social-counts"><span>${L('赞','Likes')} <b data-social-count="likes">${socialCount(d.likes)}</b></span><span>${L('转发','Reposts')} <b data-social-count="reposts">${socialCount(d.reposts)}</b></span><span>${L('回复','Replies')} <b data-social-count="replies">${socialCount(d.replies)}</b></span></div><footer><span>${esc(sourceName(item.provider_id))}</span>${socialSymbols(d).map(symbol=>go(`${tokenIcon(symbol,{size:16})}<span>${symbol}</span>`,'markets',{asset:symbol},'pd-news-asset')).join('')}${url?`<a class="pd-news-source" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${L('原帖','Original post')} ↗</a>`:''}</footer></div></article>`;
 }).join('');}

// Both data-center entrances share post cards, coverage and separate creator evidence.
export function publicRecentSocialFilters({symbol,platform},attribute){
 const select=(key,value,label,all,options)=>`<label><select ${attribute}="${key}" aria-label="${esc(label)}"><option value="">${esc(all)}</option>${options.map(option=>`<option value="${esc(option)}"${value===option?' selected':''}>${esc(option)}</option>`).join('')}</select></label>`;
 return `<div class="pd-social-filters" role="group" aria-label="${L('原帖筛选','Post filters')}">${select('social_asset',symbol,L('币种','Asset'),L('全部币种','All assets'),SOCIAL_SYMBOLS)}${select('social_platform',platform,L('平台','Platform'),L('全部平台','All platforms'),SOCIAL_PLATFORMS)}</div>`;
}

export function publicCuratedSocialFeed(snapshot,title){
 const coverage=snapshot?.coverage;
 if(coverage?.feed==='recent'&&(coverage.scope===RECENT_SOCIAL_SCOPE||lunarScope(coverage))){
  const items=snapshot.items,multi=coverage.scope===RECENT_SOCIAL_SCOPE;
  const scope=multi?L('近 24 小时 · 按原帖发布时间排序','Last 24 hours · Sorted by publication time'):L('BTC / ETH / SOL + 加密市场 · 近 24h 原帖','BTC / ETH / SOL + crypto market · 24h posts');
  return `<div class="pd-social-layout"><section class="pd-social-stream"><header class="pd-kol-heading"><h2>${esc(title||L('最近动态','Recent posts'))}</h2><span class="pd-post-caption">${items.length} ${L('条',items.length===1?'post':'posts')}</span></header><p class="pd-social-scope">${scope}</p>${items.length?`<div class="pd-news-list pd-social-list">${publicSocialRecords(items)}</div>`:notice(L('近 24 小时暂无匹配原帖','No matching posts in the last 24 hours'),L('可切换币种或平台。','Try another asset or platform.'))}</section><aside class="pd-social-context">${lunarTopics(coverage)}${publicSourceDetails({snapshot})}</aside></div>`;
 }
 if(!curatedScope(coverage))return notice(L('精选来源暂不可用','Featured creator feed unavailable'),L('请稍后重试。','Try again shortly.'));
 const items=visibleItems(snapshot),unverified=!coverage.curation?.checkedTopics.length,postsFailed=coverage.errors?.some(error=>error.resource==='posts');
 const empty=unverified?notice(L('暂时无法核验 KOL','Creator verification unavailable'),L('作者榜单与原帖均须成功返回。','Both creator rankings and original posts are required.')):postsFailed?notice(L('原帖暂不可用','Posts unavailable'),L('已返回的主题统计仍可查看。','Available topic metrics are shown separately.')):notice(L('本期暂无符合条件的原帖','No qualifying posts this period'),L('仅收录同时满足筛选条件的作者。','Only creators meeting every criterion appear here.'));
 const feed=items.length?`<div class="pd-news-list pd-social-list">${publicSocialRecords(items)}</div>`:empty;
 return `<div class="pd-social-layout"><section class="pd-social-stream">${kolHeading(coverage,items.length,title)}${feed}</section>
  <aside class="pd-social-context">${lunarTopics(coverage)}${publicSourceDetails({snapshot})}</aside></div>`;
}

export function publicSentimentCard(state){
 const asOf=state.snapshot?.asOf,last=state.snapshot?.data?.at(-1),value=Number.isInteger(last?.value)&&last.value>=0&&last.value<=100?last.value:null;
 const quality=value===null?'unavailable':state.offline||state.error?'stale':state.quality;
 const label=state.offline?L('网络已断开','Network offline'):state.pending?L('正在更新','Updating')+(value!==null&&quality==='stale'?' · '+qualityLabel('stale'):''):value===null?L('指数暂不可用','Index unavailable'):qualityLabel(quality);
 const date=Number.isFinite(asOf)&&asOf>0?new Date(asOf).toISOString():null;
 return `<section class="pd-sentiment" data-quality="${esc(quality)}" aria-label="${L('BTC 恐惧与贪婪指数','BTC Fear & Greed Index')}"><div class="pd-sentiment-heading"><h2>${tokenIcon('BTC',{size:24})}${L('BTC 恐惧与贪婪指数','BTC Fear & Greed Index')}</h2></div><div class="pd-sentiment-value"><strong data-fng-value>${value===null?'—':value}</strong><span>/ 100</span><a href="https://alternative.me/crypto/fear-and-greed-index/" target="_blank" rel="noopener noreferrer">Alternative.me ↗</a></div><div class="pd-sentiment-meta"><span>${label}</span>${date?`<time datetime="${date}">${date.slice(0,16).replace('T',' ')} UTC</time>`:''}</div></section>`;
}

export function createPublicDataViews({root,rerender,fetchImpl,now=Date.now,notify=()=>{},onAskSource=()=>{},onNewsDelivery}={}){
 let active=null,selection=0,identity='',search='',limit=20,elapsed=0,needsPaint=false,viewStamp='',refreshReturnFocus=false,suspended=false,disposed=false,sentiment,intelligenceTab='news';
 let selectedDay=null,newsSource='all',newsPublisher='all',newsDate='all';
 const contextData=createIntelligenceContext({fetchImpl,now,onChange(){if(active==='intelligence'){needsPaint=true;paint();}}});
 const savedKey='hive.dc.newsBookmarks';
 let bookmarkItems=[];
 try{
  const stored=JSON.parse(globalThis.localStorage?.getItem(savedKey)||'[]');
  if(Array.isArray(stored))bookmarkItems=newsBookmarkSnapshots(stored,stored.map(item=>item?.record_id));
 }catch{}
 const newsOptions=()=>({search,source:newsSource,publisher:newsPublisher,date:newsDate,limit,saved:bookmarkItems.map(item=>item.record_id),savedItems:bookmarkItems});
 function toggleBookmark(id){
  const saved=new Set(bookmarkItems.map(item=>item.record_id));
  if(saved.has(id))saved.delete(id);else saved.add(id);
  const next=newsBookmarkSnapshots([...bookmarkItems,...visibleItems(read('news').snapshot)],Array.from(saved));
  if(next.length!==saved.size)throw Error('Unsupported bookmark');
  globalThis.localStorage.setItem(savedKey,JSON.stringify(next));
  bookmarkItems=next;
 }
 let refreshSeconds=60;try{refreshSeconds=parseHubRefreshSeconds(globalThis.localStorage?.getItem('hive.market.refreshSeconds')||60);}catch{}
 const applyInterval=value=>{refreshSeconds=parseHubRefreshSeconds(value);sentiment?.setRefreshSeconds(refreshSeconds);};
 globalThis.window?.addEventListener?.('hive:market-refresh-interval',event=>{try{applyInterval(event.detail?.seconds);}catch{}});
 globalThis.window?.addEventListener?.('storage',event=>{if(event.key==='hive.market.refreshSeconds')try{applyInterval(event.newValue||60);}catch{}});
 const nextNewsDelivery=createNewsDeliveryReader();
 const client=createPublicDataClient({fetchImpl,now,onChange(resource){
  needsPaint=true;paint();
  if(onNewsDelivery&&resource==='news'&&active==='intelligence'&&intelligenceTab==='news'){
   const item=nextNewsDelivery(read('news'),newsOptions());
   if(item)onNewsDelivery(item);
  }
 }});
 sentiment=createMarketHubClient({fetchImpl,now,resources:['sentiment'],WebSocketImpl:null,refreshSeconds,onChange(){if(active==='intelligence'){needsPaint=true;paint();}}});
 const param=k=>new URLSearchParams(globalThis.location?.search||'').get(k);
 const socialQuery=()=>{
  const params=new URLSearchParams(globalThis.location?.search||''),feed=params.get('social_feed');
  if(feed==='recent')return {feed,...socialFiltersFromLocation(params)};
  return feed==='featured'?{feed}:{};
 };
 const selected=()=>Object.keys(PUBLIC_ASSETS).find(id=>PUBLIC_ASSETS[id]===param('asset'));
 const read=resource=>({...client.read(resource),offline:globalThis.navigator?.onLine===false});
 const displayedStatuses=new Map();
 function renderStatus(resource,state,formatTime){
  displayedStatuses.set(resource,{snapshot:state.snapshot,badge:publicStatusBadge(state)});
  return publicDataStatus(state,formatTime,resource);
 }
 function refreshVisibleBadges(){
  for(const [resource,shown] of displayedStatuses){
   const state=read(resource);
   const badge=publicStatusBadge({...state,snapshot:currentPublicEnvelope(shown.snapshot,now(),!!state.error)});
   if(badge===shown.badge)continue;
   const node=root.querySelector?.(`[data-pd-status="${resource}"] .pd-quality`);
   if(node)node.outerHTML=badge;
   shown.badge=badge;
  }
 }
 const live=page=>page==='intelligence'?param('data')!=='demo':page==='markets'&&param('data')==='live';
 const readSentiment=()=>({...sentiment.read('sentiment'),offline:globalThis.navigator?.onLine===false});
 const states=()=>[...required().map(read),...(active==='intelligence'?[readSentiment()]:[])];
 function paint(explicit=false){
  if(disposed||suspended||globalThis.document?.hidden||!active||!needsPaint||globalThis.document?.querySelector('dialog[open]'))return;
  if(!explicit&&!canAutoRefresh(root)){refreshVisibleBadges();return;}
  needsPaint=false;rerender();
  if(refreshReturnFocus&&!states().some(state=>state.pending)){
   if(globalThis.document?.activeElement===globalThis.document?.body)root.querySelector('[data-pd-refresh]:not(:disabled)')?.focus({preventScroll:true});
   refreshReturnFocus=false;
  }
 }
 function context(page){
  if(page==='intelligence'&&live(page)){
   const tab=param('feed')==='social'?'social':'news';
   if(tab!==intelligenceTab){intelligenceTab=tab;search='';}
  }
  const next=live(page)?page:null,key=next?JSON.stringify([next,param('asset'),param('chain'),limit,next==='intelligence'?intelligenceTab:null,next==='intelligence'&&intelligenceTab==='social'?socialQuery():null]):'';
  if(key!==identity){refreshReturnFocus=false;displayedStatuses.clear();client.suspend();identity=key;selection=(selection+1)%2147483647;}
  active=disposed?null:next;if(active!=='intelligence'){sentiment.setActive(false);contextData.tick(false);}return !!active;
 }
 const query=resource=>({selection_version:selection,...(['markets','assets'].includes(resource)?{asset_ids:selected()?[selected()]:Object.keys(PUBLIC_ASSETS)}:['news','social'].includes(resource)?{limit,...(resource==='social'?socialQuery():{})}:{provider_id:'etherscan',...(Object.hasOwn(PUBLIC_CHAINS,param('chain'))?{chain_id:param('chain')}:{})})});
 const required=()=>active==='markets'?param('asset')&&!selected()?[]:['markets','assets',...(Object.hasOwn(PUBLIC_CHAINS,param('chain'))?['capabilities']:[])]:active==='intelligence'?[intelligenceTab]:[];
 function load(force=false){
  const available=!disposed&&!suspended&&!globalThis.document?.hidden&&globalThis.navigator?.onLine!==false;
  for(const resource of required()){
   const input=query(resource);
   client.restore(resource,input);
   if(!available)continue;
   const s=client.read(resource),interval=resource==='capabilities'?45000:['markets','news','social'].includes(resource)?refreshSeconds*1000:300000;
   const automatic=s.error?!['INVALID_QUERY','DATA_ACCESS_DENIED'].includes(s.error):now()-s.lastAttempt>=interval;
   if(!s.pending&&!s.retryIn&&(force||s.lastAttempt==null||automatic))client.load(resource,input);
  }
  sentiment.setActive(available&&active==='intelligence');
  contextData.tick(available&&active==='intelligence',force);
  if(available&&active==='intelligence'){if(force)void sentiment.refresh();else sentiment.tick();}
 }
 const stateStamp=()=>JSON.stringify(states().map(s=>[s.pending,s.error,s.quality||s.snapshot?.quality,s.snapshot?.asOf,s.retryIn,s.offline]));
 const refresh=()=>{
  const values=states(),pending=values.some(s=>s.pending),offline=values.some(s=>s.offline),wait=Math.max(0,...values.map(s=>s.retryIn));
  const retrying=wait&&values.some(s=>s.error&&!['INVALID_QUERY','DATA_ACCESS_DENIED'].includes(s.error));
  const label=offline?L('等待网络','Waiting for network'):pending?L('正在读取','Loading'):retrying?L('自动重试','Auto retry'):L('刷新数据','Refresh');
  return dataRefreshControls({scope:'pd',seconds:refreshSeconds,intervals:HUB_REFRESH_SECONDS,busy:pending,disabled:pending||offline||!!wait||!values.length,label:label+(!pending&&wait?' · '+wait+'s':'')});
 };
 const intelligenceSearch=item=>intelligenceTab==='social'?`${item.data.platform} ${item.data.text} ${item.data.author?.acct||''} ${item.data.author?.display_name||''} ${socialSymbols(item.data).join(' ')}`:`${sourceName(item.provider_id)} ${item.data.title} ${newsSymbols(item.data).join(' ')}`;
 function sourceSnapshot(){
  if(!active)return null;
  const s=read(active==='markets'?'markets':intelligenceTab),b=s.snapshot;if(!b)return null;
  const items=active==='intelligence'&&intelligenceTab==='news'?filterIntelligenceNews(visibleItems(b),newsOptions()):visibleItems(b).filter(item=>active!=='intelligence'||intelligenceSearch(item).toLowerCase().includes(search.trim().toLowerCase()));if(!items.length&&!(active==='intelligence'&&intelligenceTab==='social'&&!search&&lunarCoverageOf(b.coverage)?.topics?.length))return null;
  return {id:'public:'+JSON.stringify([identity,search,newsSource,newsPublisher,newsDate,b.as_of_ms]),title:active==='markets'?(selected()?PUBLIC_ASSETS[selected()]+' · ':'')+L('只读现货行情','Read-only spot markets'):intelligenceTab==='social'?(b.coverage.scope===RECENT_SOCIAL_SCOPE?L('社媒原帖','Social posts'):lunarScope(b.coverage)?L('LunarCrush 社媒数据','LunarCrush social data'):L('公开社媒样本','Public social sample')):L('新闻快讯','News feed'),href:globalThis.location?.search||'',kind:active==='markets'?'market':intelligenceTab,text:JSON.stringify({mode:b.mode,quality:b.quality,offline:s.offline,error:s.error||null,as_of_ms:b.as_of_ms,coverage:b.coverage,sources:b.sources,items:active==='intelligence'?items.map(intelligenceTab==='social'?socialContext:newsContext):items},null,2)};
 }
 function sourceTools(){
  const s=read(active==='markets'?'markets':intelligenceTab),b=s.snapshot;
  const status=s.offline?L('网络已断开','Network offline'):s.pending?L('正在读取','Loading'):s.error?L('更新失败','Update failed'):b?qualityLabel(b.quality):L('暂无可用数据','Data unavailable');
  const text=b?L('数据时间','Data as of')+' '+stamp(b.as_of_ms)+' UTC+8 · '+status:status;
  return info(text,L('数据来源与时间','Source and time')).replace('class="pd-info"','class="pd-info data-header-info"')+`<button type="button" class="dc-button" data-pd-ask ${sourceSnapshot()?'':'disabled'}>${uiGlyph('chat')} ${L('问 AI','Ask AI')}</button>`;
 }
 function emptyState(s){
  const errors={DATA_SERVICE_UNAVAILABLE:L('数据服务暂未连接','Data service is unavailable'),DATA_ACCESS_DENIED:L('此入口无法读取数据','Data access unavailable'),DATA_TIMEOUT:L('读取超时','The read timed out'),INVALID_QUERY:L('筛选条件无效','Invalid filters'),DATA_RESPONSE_INVALID:L('数据暂时无法显示','The response cannot be displayed'),DATA_REQUEST_FAILED:L('数据读取失败','The read failed')};
  const title=s.offline?L('网络已断开','Network offline'):s.pending?L('正在读取数据','Loading data'):errors[s.error]||L('暂无可展示的数据','No data available');
  const detail=s.offline?L('网络恢复后会自动更新。','Updates resume when your connection returns.'):s.pending?L('正在向只读服务查询。','Requesting the read-only service.'):s.error==='DATA_ACCESS_DENIED'?L('请从本机预览入口重新打开。','Open the local preview address again.'):s.retryIn?L('稍后会自动重试。','Retrying shortly.'):L('刷新可重试。不会使用演示数据补齐，也不会影响模拟交易。','Refresh to try again. Demo data will not be substituted and simulation stays separate.');
  return notice(title,detail);
 }
 function market(){
  const s=read('markets'),a=read('assets'),id=selected(),item=s.snapshot?.items.find(i=>i.subject_id===id),profile=a.snapshot?.items.find(i=>i.subject_id===id);
  const title=id?PUBLIC_ASSETS[id]+' / USDT':L('市场行情','Markets');
  let body=`${id?go(L('← 全部行情','← All markets'),'markets',{},'pd-back'):''}<header class="p-head pd-heading"><div><h1>${title}</h1><span>${venueIcon('binance',{size:18})}${id?'Binance · Spot':L('Binance 现货 · BTC / ETH / SOL','Binance Spot · BTC / ETH / SOL')}${info(L('当前提供现货24小时统计。它不是可执行报价；K线、衍生品和TradFi尚未接入这一只读视图。','Spot 24-hour statistics only. These are not executable quotes. Candles, derivatives and TradFi are not yet connected to this view.'))}</span></div><div class="pd-actions">${refresh()}${sourceTools()}</div></header>${renderStatus('markets',s)}`;
  if(param('asset')&&!id)return body+notice(L('这个资产尚未接入','This asset is not covered'),L('当前只读市场覆盖 BTC、ETH、SOL；不会用同名资产替代。','The read-only market covers BTC, ETH and SOL. Same-name assets will not be substituted.'),go(L('返回行情','All markets'),'markets'));
  if(id){
   body+=item?`<section class="pd-quote"><div><small>${L('最新价格 / USDT','Last price / USDT')}</small><strong title="${esc(item.data.last_price)}">${esc(price(item.data.last_price))}</strong>${change(item.data.price_change_pct)}</div><div><small>${L('24h 成交量','24h base volume')}</small><b>${money(item.data.base_volume)} ${item.data.instrument.base_asset}</b></div><div><small>${L('24h 成交额','24h quote volume')}</small><b>${money(item.data.quote_volume)} USDT</b></div><div><small>${L('行情时间 · UTC+8','Market time · UTC+8')}</small><time>${stamp(item.event_time_ms)}</time></div></section>`:emptyState(s);
   body+=`<section class="pd-profile"><header><h2>${L('资产资料','Asset profile')}</h2>${renderStatus('assets',a)}</header>${profile?`<div class="pd-profile-stats"><div><small>${L('资产','Asset')}</small><strong>${esc(profile.data.name)} · ${esc(profile.data.symbol)}</strong></div><div><small>${L('总市值 / USD','Market cap / USD')}${info(L('CoinGecko资产总市值，以USD计价；与上方Binance的USDT成交统计口径不同。','CoinGecko market cap in USD. This differs from Binance USDT trading statistics above.'))}</small><strong>${money(profile.data.market_cap)}</strong></div><div><small>${L('全市场成交额 / USD','Total market volume / USD')}</small><strong>${money(profile.data.total_volume)}</strong></div></div><div class="pd-contracts">${profile.data.contracts.length?profile.data.contracts.map(c=>`<div><span>${esc(PUBLIC_CHAINS[c.chain_id]||c.chain_id)}</span><code>${esc(c.address)}</code></div>`).join(''):`<p>${L('此来源未提供合约地址。原生币不以其他链上的同名代币替代。','No contract addresses were provided. Native assets are not replaced by same-name tokens on another chain.')}</p>`}</div>`:emptyState(a)}</section>`;
   body+=Object.hasOwn(PUBLIC_CHAINS,param('chain'))?publicCapabilityView(client.read('capabilities'),param('chain')):go(L('查看各链的数据服务','View chain data services'),'markets',{asset:PUBLIC_ASSETS[id],chain:'1'},'pd-chain-link');
  }else{
   body+=`<section class="pd-market-panel"><div class="pd-table-tools"><h2>${L('现货市场','Spot markets')}</h2><label class="pd-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input data-pd-search aria-label="${L('搜索已接入资产','Search covered assets')}" placeholder="${L('搜索 BTC、ETH、SOL','Search BTC, ETH, SOL')}" value="${esc(search)}"></label></div>${s.snapshot?.items.length?publicMarketRows(s,a,{query:search}):emptyState(s)}</section>`;
   if(s.snapshot?.coverage.gaps?.length)body+=`<p class="pd-gap">${L('暂缺','Missing')}: ${s.snapshot.coverage.gaps.map(esc).join(' · ')}</p>`;
  }
  return body+publicSourceDetails(s)+(id?publicSourceDetails(a):'');
 }
 function news(){
  const social=intelligenceTab==='social',s=read(intelligenceTab),items=visibleItems(s.snapshot).filter(item=>intelligenceSearch(item).toLowerCase().includes(search.trim().toLowerCase()));
  if(!curatedScope(s.snapshot?.coverage))items.sort((a,b)=>b.data.published_at_ms-a.data.published_at_ms);
  const coverage=s.snapshot?.coverage,legacy=coverage?.scope==='SOCIAL_TAG_SAMPLES';
  const coveredEmpty=social?!!(s.snapshot&&!s.error&&s.snapshot.items.length===0&&s.snapshot.quality==='fresh'&&s.snapshot.sources.some(source=>['lunarcrush-v4','mastodon-tag-v1'].includes(source.provider_id)&&source.status==='OK')):publicEmptyNewsConfirmed(s);
  const tabs=`<div class="pd-feed-tabs" role="tablist" aria-label="${L('信息类型','Feed type')}">${[['news','新闻','News'],['social','社媒','Social']].map(([id,zh,en])=>`<button type="button" id="pd-tab-${id}" data-pd-feed="${id}" role="tab" aria-selected="${id===intelligenceTab}" aria-controls="pd-feed-panel" tabindex="${id===intelligenceTab?0:-1}">${L(zh,en)}</button>`).join('')}</div>`;
  const sample=social&&legacy?`<p class="pd-social-scope"><strong>Mastodon · ${L('公开标签样本','Public hashtag sample')}</strong><span>#bitcoin / #ethereum / #solana · ${L('每标签最多 10 条 · 不是全网舆情','Up to 10 posts per hashtag · Not network-wide sentiment')}</span></p>`:social?lunarTopics(coverage):'';
  const empty=search&&visibleItems(s.snapshot).length?notice(L('没有匹配的内容','No matching posts'),L('试试其他关键词。','Try another keyword.')):social&&curatedScope(coverage)?(!coverage.curation?.checkedTopics.length?notice(L('暂时无法核验 KOL','Creator verification unavailable'),L('作者榜单与原帖均须成功返回。','Both creator rankings and original posts are required.')):coverage.errors?.some(row=>row.resource==='posts')?notice(L('原帖暂不可用','Posts unavailable'),L('已返回的主题统计仍可查看。','Available topic metrics are shown separately.')):notice(L('本期暂无符合条件的原帖','No qualifying posts this period'),L('仅收录同时满足筛选条件的作者。','Only creators meeting every criterion appear here.'))):social&&lunarScope(coverage)&&coverage.errors?.some(row=>row.resource==='posts')?notice(L('原帖暂不可用','Posts unavailable'),L('仍可查看已返回的主题统计。','Available topic metrics are shown separately.')):coveredEmpty?notice(social?L('本次样本暂无公开帖子','No public posts in this sample'):L('本次查询暂无快讯','No news in this query'),L('来源已成功返回，覆盖范围见下方。','The source returned successfully. Query coverage is listed below.')):emptyState(s);
  const {calendar,quotes}=contextData.read();
  const feedTabs=social?`<div class="pd-feed-tabs" role="group" aria-label="${L('动态筛选','Feed selection')}">${[['recent','最近动态','Recent posts'],['featured','精选作者','Featured creators']].map(([key,zh,en])=>`<button type="button" data-pd-social-feed="${key}" aria-pressed="${(param('social_feed')==='recent'?'recent':'featured')===key}">${L(zh,en)}</button>`).join('')}</div>`:'';
  const recentFilters=socialQuery().feed==='recent'?publicRecentSocialFilters(socialQuery(),'data-pd-social-filter'):'';
  const timeline=social
   ? `${sample}<div class="pd-social-toolbar pd-social-toolbar-inline">${feedTabs}${recentFilters}</div>${curatedScope(coverage)?kolHeading(coverage,items.length):(lunarScope(coverage)||coverage?.scope===RECENT_SOCIAL_SCOPE)?`<h2 class="pd-legacy-posts">${coverage.feed==='recent'?L('近 24h 原帖 · 按发布时间排序','24h posts · By publication time'):L('历史热门原帖 · 未经 KOL 筛选','Archived top posts · Not curated')}</h2>`:''}<div class="pd-table-tools"><label class="df-search"><input data-pd-search value="${esc(search)}" placeholder="${L('搜索作者、平台或标的','Search posts, authors or platforms')}" aria-label="${L('搜索当前公开帖子','Search loaded public posts')}"></label><label class="pd-limit">${L('条数','Items')}<select data-pd-limit>${[20,50].map(n=>`<option ${limit===n?'selected':''}>${n}</option>`).join('')}</select></label></div>${items.length?`<div class="pd-news-list pd-social-list">${publicSocialRecords(items)}</div>`:empty}`
   : renderIntelligenceNewsFeed(visibleItems(s.snapshot),{...newsOptions(),empty});
  const sidebar=renderIntelligenceNewsAside(social?[]:visibleItems(s.snapshot),renderIntelligenceMarkets(quotes)+publicSentimentCard(readSentiment()),newsOptions());
  return `<div class="df-root df-news">
   <header class="df-page-head"><h1>${L('新闻舆情','News & sentiment')}</h1><div>${refresh()}${sourceTools()}${tabs}</div></header>
   <div class="df-news-layout"><main class="df-news-main">
    ${renderIntelligenceCalendar(calendar.snapshot,{...calendar,now:now(),selectedDay})}
    <section id="pd-feed-panel" role="tabpanel" aria-labelledby="pd-tab-${intelligenceTab}">${timeline}${renderStatus(intelligenceTab,s,feedDateTime.format)}${publicSourceDetails(s)}</section>
   </main>${sidebar}</div></div>`;
 }
 function render(page){if(!context(page))return null;load();viewStamp=stateStamp();return `<div class="dc-root pd-root" data-public-data="${page}">${publicDataModebar(page)}${page==='markets'?market():news()}</div>`;}
 function bind(){
  root.querySelectorAll('.pd-info summary').forEach(el=>el.addEventListener('keydown',e=>{if(e.key==='Escape'){el.parentElement.open=false;el.focus();}}));
  if(!active)return;
  const selectFeed=value=>{if(!['news','social'].includes(value)||value===intelligenceTab)return;const url=new URL(location.href);if(value==='social')url.searchParams.set('feed','social');else url.searchParams.delete('feed');history.pushState(history.state,'',url);context(active);load();needsPaint=true;paint(true);};
  for(const button of root.querySelectorAll('[data-pd-feed]')){button.addEventListener('click',()=>selectFeed(button.dataset.pdFeed));button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const value=event.key==='Home'?'news':event.key==='End'?'social':intelligenceTab==='news'?'social':'news';selectFeed(value);root.querySelector(`[data-pd-feed="${value}"]`)?.focus();});}
  const navigateSocial=url=>{history.pushState(history.state,'',url);context(active);load();needsPaint=true;paint(true);};
  for(const button of root.querySelectorAll('[data-pd-social-feed]'))button.addEventListener('click',()=>{
   const value=button.dataset.pdSocialFeed;if(!['recent','featured'].includes(value)||button.getAttribute?.('aria-pressed')==='true')return;
   const url=new URL(location.href);url.searchParams.set('social_feed',value);
   if(value==='featured')for(const key of ['social_asset','social_platform'])url.searchParams.delete(key);
   navigateSocial(url);
  });
  for(const filter of root.querySelectorAll('[data-pd-social-filter]'))filter.addEventListener('change',()=>{
   const url=new URL(location.href),key=filter.dataset.pdSocialFilter;
   if(filter.value)url.searchParams.set(key,filter.value);else url.searchParams.delete(key);
   navigateSocial(url);
  });
  root.querySelector('[data-pd-refresh]')?.addEventListener('click',()=>{if(states().some(s=>s.pending||s.offline||s.retryIn))return;refreshReturnFocus=globalThis.document?.activeElement===root.querySelector('[data-pd-refresh]');load(true);needsPaint=true;paint(true);});
  root.querySelector('[data-pd-interval]')?.addEventListener('change',event=>{
   const old=refreshSeconds;try{const seconds=parseHubRefreshSeconds(event.target.value);localStorage.setItem('hive.market.refreshSeconds',String(seconds));applyInterval(seconds);window.dispatchEvent(new CustomEvent('hive:market-refresh-interval',{detail:{seconds}}));notify(L('自动刷新：','Auto refresh: ')+seconds+' '+L('秒','seconds'));}
   catch{event.target.value=String(old);notify(L('设置未保存，请重试','Settings could not be saved. Try again.'));}
  });
  root.querySelector('[data-pd-ask]')?.addEventListener('click',()=>{const source=sourceSnapshot();if(source)onAskSource(source);});
  const repaint=()=>{needsPaint=true;paint(true);};
  for(const button of root.querySelectorAll('[data-pd-bookmark]'))button.onclick=()=>{
   const tracked=newsSource==='saved'&&root.ownerDocument?.activeElement===button;
   const index=tracked?[...root.querySelectorAll('[data-pd-bookmark]')].indexOf(button):-1;
   try{
    toggleBookmark(button.dataset.value);repaint();
    if(index>=0){
     const remaining=root.querySelectorAll('[data-pd-bookmark]');
     const next=remaining[Math.min(index,remaining.length-1)]||root.querySelector('[data-pd-news-reset]');
     next?.focus({preventScroll:true});
    }
   }catch{notify(L('快讯未能保存，请重试','Could not save this story. Try again.'));}
  };
  for(const button of root.querySelectorAll('[data-intelligence-day]'))button.onclick=()=>{selectedDay=button.dataset.intelligenceDay;repaint();root.querySelector(`[data-intelligence-day="${selectedDay}"]`)?.focus({preventScroll:true});};
  for(const button of root.querySelectorAll('[data-pd-news-source]'))button.onclick=()=>{
   const offset=button.parentElement.scrollLeft;
   newsSource=button.dataset.pdNewsSource;repaint();
   const selected=root.querySelector('[data-pd-news-source][aria-pressed="true"]');
   if(selected){selected.parentElement.scrollLeft=offset;selected.focus({preventScroll:true});}
  };
  const date=root.querySelector('[data-pd-news-date]');
  if(date)date.onchange=()=>{newsDate=date.value;repaint();};
  const publisher=root.querySelector('[data-pd-news-publisher]');
  if(publisher)publisher.onchange=()=>{newsPublisher=publisher.value;repaint();};
  const reset=root.querySelector('[data-pd-news-reset]');
  if(reset)reset.onclick=()=>{search='';newsSource='all';newsPublisher='all';newsDate='all';repaint();};
  const input=root.querySelector('[data-pd-search]');if(input)bindSearchRender(input,value=>{search=value;},()=>{needsPaint=true;paint(true);return root.querySelector('[data-pd-search]');});
  root.querySelector('[data-pd-limit]')?.addEventListener('change',e=>{limit=Number(e.target.value);context(active);load();needsPaint=true;paint(true);});
  root.querySelector('[data-pd-chain]')?.addEventListener('change',e=>{const u=new URL(location.href);u.searchParams.set('chain',e.target.value);history.pushState(null,'',u);window.dispatchEvent(new PopStateEvent('popstate'));});
  load();
 }
 function companionBrief(cursor=0){
  if(!active)return null;
  const s=client.read(active==='markets'?'markets':intelligenceTab),b=s.snapshot;
  const rows=b?.coverage.scope==='NEWS_FEED'?filterIntelligenceNews(visibleItems(b),{...newsOptions(),savedItems:[]}):visibleItems(b);
  const item=rows[Math.floor(Math.max(cursor,0)/3)%Math.max(rows.length,1)],mode=b?.mode==='live_readonly'?L('只读数据','Read-only data'):b?.mode==='offline_fixture'?L('离线测试样本','Offline fixture'):L('数据状态','Data status');
  const link=href(active),base={kind:'data',label:L('数据简报','Data brief'),modeLabel:b?mode:L('只读','Read-only'),timestamp:b?.as_of_ms===null||!b?null:stamp(b.as_of_ms)+' UTC+8',visual:'',href:link,action:L('查看当前数据','View current data'),source:mode};
  if(!item&&active==='intelligence'&&intelligenceTab==='social'&&lunarScope(b?.coverage)&&b.coverage.topics?.length){const topic=b.coverage.topics[0];return {...base,kind:'social',label:L('社媒热度','Social activity'),title:topic.symbol,body:L('24h 互动 ','24h interactions ')+socialCount(topic.interactions24h),source:'LunarCrush'};}
  if(!item&&b?.coverage.scope==='NEWS_FEED'&&!s.error&&['fresh','partial'].includes(b.quality))return {...base,title:L('没有匹配的快讯','No matching stories'),body:''};
  if(!item)return {...base,title:L('数据服务暂未连接','Data service is unavailable'),body:L('我还没有拿到可用数据。刷新可以重试；不会把演示行情当成实时行情。','No usable data has arrived. Refresh to try again; demo prices will not stand in for live data.')};
  if(active==='intelligence'&&intelligenceTab==='social'&&lunarPost(item))return {...base,kind:'social',label:curatedScope(b.coverage)?L('精选 KOL','Featured creator'):L('历史热门原帖','Archived top post'),title:item.data.author?.display_name||item.data.author?.acct||item.data.platform,body:L('24h 互动 ','24h interactions ')+socialCount(item.data.interactions_24h),href:safePublicURL(item.data.url)||link,source:'LunarCrush · '+item.data.platform+' · '+stamp(item.data.published_at_ms)+' UTC+8'};
  if(active==='intelligence'&&intelligenceTab==='social')return {...base,kind:'social',label:L('公开社媒样本','Public social sample'),title:item.data.author.display_name||item.data.author.acct,body:L('赞 ','Likes ')+socialCount(item.data.likes)+' · '+L('转发 ','Reposts ')+socialCount(item.data.reposts)+' · '+L('回复 ','Replies ')+socialCount(item.data.replies),href:safePublicURL(item.data.url)||link,source:'Mastodon · '+stamp(item.data.published_at_ms)+' UTC+8'};
  if(active==='intelligence')return {...base,kind:'news',label:L('一条快讯','News brief'),title:item.data.title,body:L('阅读原文','Read original article'),href:safePublicURL(item.data.url)||link,source:sourceName(item.provider_id)+' · '+stamp(item.data.published_at_ms)+' UTC+8'};
  const d=item.data;
  if(cursor%3===2)return {...base,kind:'analysis',label:L('数据提醒','Data note'),title:item.quality==='fresh'?L('先区分数据与交易','Keep data and trading separate'):L('这条行情已经过期','This market record is stale'),body:item.quality==='fresh'?L('这里是 Binance 现货的24小时统计，还没有接入K线、AI分析或交易执行。这次点击不会下单。','These are Binance Spot 24-hour statistics. Candles, AI analysis and execution are not connected to this view. This click does not place an order.'):L('源时间保留在页面上。恢复更新前，不能把这条记录当成最新报价。','The original source time is retained. Do not treat this record as a current quote until updates recover.')};
  return {...base,title:d.instrument.base_asset+' / USDT · '+price(d.last_price),body:L('Binance 现货；源时间 '+stamp(item.event_time_ms)+' UTC+8。24h成交额 '+money(d.quote_volume)+' USDT。','Binance Spot, source time '+stamp(item.event_time_ms)+' UTC+8. 24h quote volume '+money(d.quote_volume)+' USDT.'),href:href('markets',{asset:d.instrument.base_asset}),source:sourceName(item.provider_id)};
 }
 function currentNewsStory(preferredId){
  if(active!=='intelligence'||intelligenceTab!=='news')return null;
  const snapshot=client.read('news').snapshot;
  if(snapshot?.mode!=='live_readonly')return null;
  const stories=filterIntelligenceNews(visibleItems(snapshot),{...newsOptions(),savedItems:[]}).filter(item=>safePublicURL(item.data.url));
  return stories.find(item=>item.record_id===preferredId)||stories[0]||null;
 }
 const visibilityChanged=()=>{if(globalThis.document?.hidden){sentiment.setActive(false);contextData.tick(false);client.suspend();}else if(active)load();};
 const pageHidden=event=>{suspended=true;sentiment.setActive(false);contextData.tick(false);client.suspend();if(!event.persisted)dispose();};
 const pageShown=event=>{if(event.persisted&&suspended&&!disposed){suspended=false;if(active)load();}};
 globalThis.document?.addEventListener?.('visibilitychange',visibilityChanged);
 globalThis.window?.addEventListener?.('pagehide',pageHidden);
 globalThis.window?.addEventListener?.('pageshow',pageShown);
 function dispose(){
  if(disposed)return;disposed=true;active=null;client.clear();sentiment.dispose();contextData.dispose();
  globalThis.document?.removeEventListener?.('visibilitychange',visibilityChanged);
  globalThis.window?.removeEventListener?.('pagehide',pageHidden);
  globalThis.window?.removeEventListener?.('pageshow',pageShown);
 }
 return {render,bind,sync:context,sourceSnapshot,modebar:publicDataModebar,companionBrief,currentNewsStory,tick(page,dt){context(page);elapsed+=dt;if(elapsed>=1){elapsed=0;load();const next=stateStamp();if(next!==viewStamp){viewStamp=next;needsPaint=true;}paint();}},client,dispose};
}
