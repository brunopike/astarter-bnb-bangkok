export const BLOCKBEATS_URL='https://api-pro.theblockbeats.info/v1/newsflash?page=1&size=20&lang=cn';
const maxBytes=384000,requireValid=value=>{if(!value)throw Error('BLOCKBEATS_INVALID_RESPONSE');};
const assets=[['BTC',/比特币|\b(?:btc|bitcoin)\b/i],['ETH',/以太(?:坊|币)|\b(?:eth|ether|ethereum)\b/i],['SOL',/\b(?:sol|solana)\b/i],['SPX',/标普\s*500|\b(?:spx|s&p\s*500)\b/i],['NDX',/纳斯达克\s*100|纳指\s*100|\b(?:ndx|nasdaq[ -]?100)\b/i],['XAU',/黄金|\b(?:gold|xau)\b/i],['DXY',/美元指数|\b(?:dxy|dollar index)\b/i],['US10Y',/(?:美国|美债).{0,5}(?:10|十)年|(?:10|十)年期美债|\b(?:us10y|10[ -]year treasury)\b/i]];

export function parseBlockBeats(body,receivedAt=Date.now()){
 if(![0,200].includes(body?.status))throw Error('BLOCKBEATS_API_REJECTED');
 const rows=body.data?.data;requireValid(Array.isArray(rows)&&rows.length<=20&&Number.isSafeInteger(receivedAt)&&receivedAt>0);
 const byId=new Map();
 for(const row of rows){
  const id=String(row?.id??'');requireValid(/^[1-9]\d{0,15}$/.test(id)&&Number.isSafeInteger(Number(id)));
  requireValid(typeof row.title==='string'&&row.title.trim().length>0&&row.title.length<=600&&!/[\u0000-\u001f\u007f]/.test(row.title));
  requireValid(typeof row.link==='string'&&new RegExp('^https://(?:www\\.|m\\.)?theblockbeats\\.info/flash/'+id+'$').test(row.link));
  requireValid(typeof row.create_time==='string'&&/^\d{4}-\d\d-\d\d (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(row.create_time));
  const local=row.create_time.replace(' ','T'),publishedAt=Date.parse(local+'+08:00');
  requireValid(Number.isSafeInteger(publishedAt)&&publishedAt>0&&publishedAt<=receivedAt+60000&&new Date(publishedAt+28800000).toISOString().slice(0,19)===local);
  if(!byId.has(id))byId.set(id,{id:'blockbeats:'+id,title:row.title.trim(),url:row.link,publishedAt,symbols:assets.filter(([,match])=>match.test(row.title)).map(([symbol])=>symbol),revision:null});
 }
 return [...byId.values()].sort((first,second)=>second.publishedAt-first.publishedAt);
}

export async function fetchBlockBeats(fetchImpl,key,signal=AbortSignal.timeout(8000)){
 if(typeof key!=='string'||!key.trim()||/[\r\n]/.test(key))throw Error('BLOCKBEATS_UNCONFIGURED');
 const response=await fetchImpl(BLOCKBEATS_URL,{headers:{'api-key':key,Accept:'application/json'},credentials:'omit',redirect:'error',signal});
 if(!response.ok||response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>maxBytes){
  await response.body?.cancel().catch(()=>{});throw Error('BLOCKBEATS_UNAVAILABLE');
 }
 const reader=response.body?.getReader();requireValid(reader);
 const chunks=[];let bytes=0;
 try{
  for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;requireValid(bytes<=maxBytes);chunks.push(value);}
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));requireValid(!raw.includes(key));
 let body;try{body=JSON.parse(raw);}catch{throw Error('BLOCKBEATS_INVALID_RESPONSE');}
 return parseBlockBeats(body);
}
