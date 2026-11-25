import {PUBLIC_ASSETS,validatePublicEnvelope} from './public-data-client.mjs';
import {pair as L} from './locale.mjs';

const HOUR=3600000,DAY=24*HOUR;

// Convert the public feed into asset-specific, read-only citations. Post bodies
// never enter research state or the model request.
export function publicResearchFacts(resource,body,now){
 if(!['news','social'].includes(resource)||body?.mode!=='live_readonly'||!['fresh','partial'].includes(body.quality)||!Number.isSafeInteger(now))return [];
 try{validatePublicEnvelope(body,resource,{limit:50,selection_version:body.selection_version});}catch{return [];}
 if(!(body.requested_at_ms>0&&body.requested_at_ms<=now+1000))return [];
 const facts=[];
 if(resource==='news'){
  if(body.coverage.scope!=='NEWS_FEED'||!body.sources.some(row=>row.provider_id==='blockbeats-news-v1'&&row.status==='OK'))return [];
  for(const item of body.items){
   const d=item.data,at=d.published_at_ms,expires=Math.min(at+DAY,item.valid_until_ms);
   if(item.provider_id!=='blockbeats-news-v1'||item.quality!=='fresh'||!(at>0&&at<=now+60000&&expires>now)||!/^https:\/\/(?:m\.|www\.)?theblockbeats\.info\/flash\/\d+$/.test(d.url))continue;
   for(const symbol of d.symbols??d.asset_ids.map(id=>PUBLIC_ASSETS[id]))facts.push({kind:'news',symbol,id:item.record_id,at,expires,url:d.url,title:d.title});
  }
 }else{
  const coverage=body.coverage,observed=coverage.observed_at_ms,expires=observed+HOUR;
  if(coverage.scope!=='LUNARCRUSH_KOL_TOPICS'||observed>now+1000||expires<=now||!body.sources.some(row=>row.provider_id==='lunarcrush-v4'&&row.status==='OK'))return [];
  for(const topic of coverage.topics){
   const {symbol,posts24h,contributors24h,interactions24h,sentimentByNetwork}=topic;
   if(coverage.errors.some(error=>error.symbol===symbol&&error.resource==='topic')||topic.asOf!==null&&topic.asOf+HOUR<=now)continue;
   if([posts24h,contributors24h,interactions24h].every(value=>value===null)&&!Object.keys(sentimentByNetwork).length)continue;
   facts.push({kind:'topic',symbol,id:'lunar-topic:'+symbol,at:topic.asOf??observed,retrieved:topic.asOf===null,expires:Math.min(expires,(topic.asOf??observed)+HOUR),posts24h,contributors24h,interactions24h,sentimentByNetwork});
  }
  for(const item of body.items){
   const d=item.data,symbol=d.kol.evidenceSymbol;
   if(item.quality!=='fresh'||d.published_at_ms+DAY<=now||coverage.errors.some(error=>error.symbol===symbol&&['creators','posts'].includes(error.resource)))continue;
   facts.push({kind:'kol',symbol,id:item.record_id,at:d.published_at_ms,expires:Math.min(expires,d.published_at_ms+DAY),url:d.url,author:d.author.display_name||d.author.acct,platform:d.platform,rank:d.kol.topicRank,followers:d.kol.followers});
  }
 }
 return facts.sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id));
}

export function publicResearchSummary(facts){
 const news=facts.filter(item=>item.kind==='news'),topic=facts.find(item=>item.kind==='topic'),kol=facts.filter(item=>item.kind==='kol');
 const counts=topic?[[topic.posts24h,'条帖子','posts'],[topic.contributors24h,'位作者','contributors'],[topic.interactions24h,'次互动','interactions']].filter(([n])=>n!==null).map(([n,zh,en])=>n.toLocaleString('en-US')+' '+L(zh,en)):[];
 return [news.length?L(`律动 · ${news.length} 条相关快讯`,`BlockBeats · ${news.length} matching headlines`):'',topic?'LunarCrush · '+L('24 小时主题讨论','24h topic activity')+(counts.length?' · '+counts.join(' · '):''):'',kol.length?L(`LunarCrush · ${kol.length} 条精选 KOL 原帖`,`LunarCrush · ${kol.length} curated KOL posts`):''].filter(Boolean).join(' / ');
}
