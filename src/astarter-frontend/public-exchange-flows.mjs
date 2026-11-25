const DAY=86_400_000;
const SOURCE='https://cryptokeyhole.com/exchanges/';
export const EXCHANGE_FLOW_POLICY=Object.freeze({
 url:'https://cryptokeyhole.com/api/v1/exchanges?view=daily',interval:30*60_000,stale:36*60*60_000,
 maxBytes:180_000,cacheKey:'exchange-netflow:daily-usd:v1'
});

function validVenue(row){
 return typeof row?.name==='string'&&/^[A-Za-z0-9][A-Za-z0-9. ()_-]{0,59}$/.test(row.name)&&
  typeof row.slug==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.slug)&&
  Number.isFinite(row.netUsd)&&(row.net7dUsd===null||Number.isFinite(row.net7dUsd))&&
  Array.isArray(row.assets)&&row.assets.length>0&&row.assets.length<=30&&
  row.assets.every(id=>typeof id==='string'&&/^[A-Z0-9]{1,12}$/.test(id))&&new Set(row.assets).size===row.assets.length;
}

export function validateExchangeFlows(body,now=Date.now()){
 return body?.schema==='exchange-netflow-v1'&&body.source==='CryptoKeyhole'&&body.sourceUrl===SOURCE&&body.unit==='USD'&&
  Number.isSafeInteger(body.startAt)&&body.startAt>0&&body.startAt%DAY===0&&body.endAt===body.startAt+DAY&&
  Number.isSafeInteger(body.publishedAt)&&body.publishedAt>=body.endAt&&body.publishedAt<=now+60_000&&
  Array.isArray(body.rows)&&body.rows.length>0&&body.rows.length<=80&&body.rows.every(validVenue)&&
  new Set(body.rows.map(row=>row.slug)).size===body.rows.length&&body.rows.every((row,i)=>!i||body.rows[i-1].netUsd>=row.netUsd);
}

function decodeDaily(raw,now){
 if(raw?.view!=='daily'||raw.plan!=='free'||!Array.isArray(raw.rows)||!Array.isArray(raw.assets)||
  ![raw.period?.start,raw.period?.end,raw.generatedAt].every(Number.isSafeInteger))throw Error('INVALID_DATA');
 const included=new Set(raw.assets.filter(item=>item?.included===true).map(item=>item.id));
 const rows=raw.rows.map(item=>({
  name:item.exchange,slug:item.slug,netUsd:item.net,net7dUsd:item.net7d??null,
  assets:Array.isArray(item.coins)?item.coins.filter(id=>included.has(id)):[]
 })).sort((a,b)=>b.netUsd-a.netUsd);
 const body={schema:'exchange-netflow-v1',source:'CryptoKeyhole',sourceUrl:SOURCE,unit:'USD',
  startAt:raw.period.start*1000,endAt:raw.period.end*1000,publishedAt:raw.generatedAt*1000,rows};
 if(!validateExchangeFlows(body,now))throw Error('INVALID_DATA');
 return body;
}

export function publicExchangeFlowsRequest(params){
 if(params.size)return null;
 return {key:'exchange-netflow:daily',resource:'exchange-netflow',policy:EXCHANGE_FLOW_POLICY,decode:([raw],now)=>decodeDaily(raw,now)};
}
