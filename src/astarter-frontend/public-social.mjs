import {PUBLIC_SCHEMA,PUBLIC_PROJECTION,publicQuery,safePublicURL} from './public-data-client.mjs';

const tags=Object.freeze(['bitcoin','ethereum','solana']),symbols=Object.freeze({bitcoin:'BTC',ethereum:'ETH',solana:'SOL'}),providerId='mastodon-tag-v1';
export const PUBLIC_SOCIAL_SOURCE=Object.freeze({urls:Object.freeze(tags.map(tag=>`https://mastodon.social/api/v1/timelines/tag/${tag}?limit=10`)),provider:'Mastodon.social',interval:120000,stale:300000,maxBytes:200000,headers:Object.freeze({Accept:'application/json'})});
const check=value=>{if(!value)throw Error('INVALID_SOCIAL');};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const string=(value,max,empty=false)=>typeof value==='string'&&value.length<=max&&(empty||value.length>0);
const plain=value=>value.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<br\b[^>]*>|<\/(?:p|div|li|blockquote)\s*>/gi,' ').replace(/<[^>]*>/g,'').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,key)=>{
 if(key[0]!=='#')return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[key.toLowerCase()];
 const code=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'';
}).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/\s+/g,' ').trim();
function url(value){check(string(value,2048)&&!/[\u0000-\u0020\u007f]/.test(value));const result=safePublicURL(value);check(result!==null);return result;}
function date(value){check(string(value,80)&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value));const result=Date.parse(value);check(Number.isSafeInteger(result)&&result>0&&new Date(value.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)===value.slice(0,10));return result;}
function normalizePost(row,receivedAt){
 check(object(row)&&string(row.id,100)&&/^[0-9]+$/.test(row.id));const id=row.id,uri=url(row.uri),publishedAt=date(row.created_at),editedAt=row.edited_at===null?null:date(row.edited_at);
 check(publishedAt<=receivedAt+60000&&(editedAt===null||editedAt>=publishedAt&&editedAt<=receivedAt+60000));
 check(['public','unlisted','private','direct'].includes(row.visibility)&&typeof row.sensitive==='boolean'&&string(row.spoiler_text,20000,true));
 // Excluded duplicates also suppress a copy fetched before a warning/privacy change.
 if(row.visibility!=='public'||row.sensitive||row.spoiler_text.trim()||row.reblog!=null)return {id,uri,excluded:true};
 check(string(row.content,20000,true));const full=plain(row.content);if(!full)return {id,uri,excluded:true};
 let text=full.slice(0,600);if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
 const account=row.account;check(object(account)&&string(account.acct,200)&&!/[\s<>\u0000-\u001f\u007f]/.test(account.acct)&&string(account.display_name,300,true)&&(account.bot==null||typeof account.bot==='boolean'));
 const author={acct:account.acct,display_name:plain(account.display_name),url:url(account.url),bot:account.bot??null};
 check(Array.isArray(row.tags)&&row.tags.length<=100);const named=new Set();for(const tag of row.tags){check(object(tag)&&string(tag.name,200));named.add(tag.name.toLowerCase());}
 check(['favourites_count','reblogs_count','replies_count'].every(key=>Number.isSafeInteger(row[key])&&row[key]>=0));
 return {id,uri,url:url(row.url??row.uri),author,text,truncated:text.length<full.length,publishedAt,editedAt,symbols:tags.filter(tag=>named.has(tag)).map(tag=>symbols[tag]),likes:row.favourites_count,reposts:row.reblogs_count,replies:row.replies_count};
}

// Fixed-instance public samples only. Cards, media and nested reposts are never fetched or projected.
export function normalizePublicSocial(raw,receivedAt){
 try{
  check(Number.isSafeInteger(receivedAt)&&receivedAt>0&&receivedAt<=Number.MAX_SAFE_INTEGER-86400000&&Array.isArray(raw)&&raw.length===3);
  const ids=new Map(),byURI=new Map(),excluded=new Set();
  for(const feed of raw){check(Array.isArray(feed)&&feed.length<=10);for(const value of feed){
   const item=normalizePost(value,receivedAt),old=byURI.get(item.uri);check(!ids.has(item.id)||ids.get(item.id)===item.uri);check(!old||old.id===item.id);ids.set(item.id,item.uri);
   if(item.excluded){excluded.add(item.uri);continue;}
   if(!old||(item.editedAt??item.publishedAt)>=(old.editedAt??old.publishedAt))byURI.set(item.uri,item);
  }}
  const items=[...byURI.values()].filter(item=>!excluded.has(item.uri)).sort((a,b)=>b.publishedAt-a.publishedAt||a.id.localeCompare(b.id));
  return {items,asOf:receivedAt,receivedAt};
 }catch{throw Error('INVALID_SOCIAL');}
}

export function projectPublicSocial(snapshot,query,requestedAt){
 let selection;try{selection=publicQuery('social',query);}catch{throw Error('INVALID_SOCIAL');}
 check(object(snapshot)&&Array.isArray(snapshot.items)&&snapshot.items.length<=30&&Number.isSafeInteger(snapshot.receivedAt)&&snapshot.receivedAt>0&&Number.isSafeInteger(requestedAt)&&requestedAt>=snapshot.receivedAt-60000);
 const items=snapshot.items.slice(0,selection.limit).map(item=>{
  const validUntil=Math.min(item.publishedAt+86400000,snapshot.receivedAt+PUBLIC_SOCIAL_SOURCE.stale);
  return {record_id:providerId+':'+item.id,subject_id:'social:'+item.id,provider_id:providerId,quality:requestedAt>=validUntil?'stale':'fresh',event_time_ms:item.publishedAt,received_at_ms:snapshot.receivedAt,available_at_ms:snapshot.receivedAt,valid_until_ms:validUntil,venue_or_chain:null,source_revision:String(item.editedAt??item.publishedAt),data:{metric_kind:'PUBLIC_SOCIAL_POST',platform:'Mastodon',instance:'mastodon.social',post_id:item.id,url:item.url,author:{...item.author},text:item.text,truncated:item.truncated,published_at_ms:item.publishedAt,edited_at_ms:item.editedAt,observed_at_ms:snapshot.receivedAt,symbols:[...item.symbols],likes:item.likes,reposts:item.reposts,replies:item.replies}};
 });
 const stale=items.filter(item=>item.quality==='stale').length;
 return {schema_version:PUBLIC_SCHEMA,tenant_scope:'PUBLIC',projection_version:PUBLIC_PROJECTION,request_id:'social:'+snapshot.receivedAt,selection_version:selection.selection_version,mode:'live_readonly',real_trading_connected:false,execution_binding:'NONE',quality:stale===items.length&&items.length?'stale':stale?'partial':'fresh',as_of_ms:snapshot.asOf,requested_at_ms:requestedAt,coverage:{scope:'SOCIAL_TAG_SAMPLES',instance:'mastodon.social',tags:[...tags],sample_cap:30,as_of_basis:'sample_receipt',asset_matching:'exact hashtags',content:'public post excerpts',metrics:'instance-observed interactions'},missing_capabilities:['social.full_network','social.user_totals','social.sentiment_score','social.ai_analysis'],sources:[{provider_id:providerId,status:'OK',last_success_at_ms:snapshot.receivedAt,reason_code:null,retry_after_seconds:null}],items};
}
