import {PUBLIC_SCHEMA,PUBLIC_PROJECTION,PUBLIC_ASSETS} from './public-data-client.mjs';
import {XMLParser,XMLValidator} from 'fast-xml-parser';

export const PUBLIC_NEWS_SOURCE=Object.freeze({url:'https://www.coindesk.com/arc/outboundfeeds/rss',provider:'CoinDesk',interval:300000,stale:86400000,maxBytes:128000,headers:{Accept:'application/rss+xml, application/xml, text/xml'}});
const providerId='coindesk-rss-v1';
const check=value=>{if(!value)throw Error('INVALID_NEWS');};
const plain=value=>String(value??'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(match,key)=>{
 if(key[0]!=='#')return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[key.toLowerCase()];
 const code=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'';
}).replace(/\s+/g,' ').trim();
const parser=new XMLParser({ignoreDeclaration:true,ignorePiTags:true,ignoreAttributes:true,parseTagValue:false,processEntities:false,isArray:(name,path)=>path==='rss.channel.item'});
const field=(node,name,optional=false)=>{const value=node[name];check(typeof value==='string'||optional&&value===undefined);return plain(value);};
const symbols=[['BTC',/\b(bitcoin|btc)\b/i],['ETH',/\b(ethereum|ether|eth)\b/i],['SOL',/\b(solana|sol)\b/i],['SPX',/\b(s&p\s*500|spx)\b/i],['NDX',/\b(nasdaq[ -]?100|ndx)\b/i],['XAU',/\b(gold|xau)\b/i],['DXY',/\b(dollar index|dxy)\b/i],['US10Y',/\b(10[ -]year treasury|10[ -]year yield|us10y)\b/i]];

// The fixed publisher feed supplies headline links only; publisher body/description never leaves this parser.
export function parsePublicNews(raw,receivedAt){
 check(typeof raw==='string'&&raw.length<=PUBLIC_NEWS_SOURCE.maxBytes&&Number.isSafeInteger(receivedAt)&&receivedAt>0&&!/<!DOCTYPE|<!ENTITY/i.test(raw));
 let document;try{check(XMLValidator.validate(raw)===true);document=parser.parse(raw);}catch{throw Error('INVALID_NEWS');}
 const channel=document?.rss?.channel;check(Object.keys(document).length===1&&channel&&typeof channel==='object'&&!Array.isArray(channel)&&/CoinDesk/i.test(field(channel,'title')));
 const records=channel.item??[];check(Array.isArray(records)&&records.length<=100);
 const items=records.map(xml=>{
  const title=field(xml,'title'),publishedAt=Date.parse(field(xml,'pubDate'));let link;
  try{link=new URL(field(xml,'link'));}catch{throw Error('INVALID_NEWS');}
  check(title.length>0&&title.length<=600&&Number.isSafeInteger(publishedAt)&&publishedAt>0&&publishedAt<=receivedAt+60000&&link.protocol==='https:'&&['coindesk.com','www.coindesk.com'].includes(link.hostname)&&!link.username&&!link.password&&link.pathname!=='/');
  link.search='';link.hash='';const url=link.href;check(url.length<=260);
  return {id:url,title,url,publishedAt,symbols:symbols.filter(([,pattern])=>pattern.test(title)).map(([symbol])=>symbol),revision:field(xml,'guid',true).slice(0,300)||null};
 }).sort((a,b)=>b.publishedAt-a.publishedAt);
 const byId=new Map();for(const item of items)if(!byId.has(item.id))byId.set(item.id,item);const unique=[...byId.values()];
 return {items:unique,asOf:unique[0]?.publishedAt??null,receivedAt};
}

export function projectPublicNews(snapshot,query,requestedAt,sourceId=providerId){
 const items=snapshot.items.slice(0,query.limit).map(item=>{
  const validUntil=item.publishedAt+PUBLIC_NEWS_SOURCE.stale;
  return {record_id:sourceId+':'+item.id,subject_id:'news:'+item.id,provider_id:sourceId,quality:requestedAt>=validUntil?'stale':'fresh',event_time_ms:item.publishedAt,received_at_ms:snapshot.receivedAt,available_at_ms:snapshot.receivedAt,valid_until_ms:validUntil,venue_or_chain:null,source_revision:item.revision,data:{news_id:item.id,title:item.title,summary:'',url:item.url,published_at_ms:item.publishedAt,symbols:item.symbols,asset_ids:Object.entries(PUBLIC_ASSETS).filter(([,symbol])=>item.symbols.includes(symbol)).map(([id])=>id)}};
 });
 const stale=items.filter(item=>item.quality==='stale').length;
 return {schema_version:PUBLIC_SCHEMA,tenant_scope:'PUBLIC',projection_version:PUBLIC_PROJECTION,request_id:'news:'+snapshot.receivedAt,selection_version:query.selection_version,mode:'live_readonly',real_trading_connected:false,execution_binding:'NONE',quality:stale===items.length&&items.length?'stale':stale?'partial':'fresh',as_of_ms:snapshot.asOf??snapshot.receivedAt,requested_at_ms:requestedAt,coverage:{scope:'NEWS_FEED',provider:'CoinDesk',asset_matching:'headline keywords',content:'headline links'},missing_capabilities:['social.posts','social.sentiment','news.ai_analysis'],sources:[{provider_id:providerId,status:'OK',last_success_at_ms:snapshot.receivedAt,reason_code:null,retry_after_seconds:null}],items};
}
