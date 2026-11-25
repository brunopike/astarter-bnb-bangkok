const MINUTE=60_000;
export const LIQUIDATION_ASSETS=Object.freeze(['BTC','ETH','SOL']);
const SOURCE=Object.freeze({name:'MarginPad',url:'https://marginpad.io/liquidations/',termsUrl:'https://marginpad.io/terms/'});
const API='https://marginpad.io/api/v1/';
const usd=value=>Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
const timely=(at,now)=>Number.isSafeInteger(at)&&at>0&&at<=now+MINUTE&&at>=now-60*MINUTE;
const hasSides=row=>row&&[row.long,row.short,row.total].every(usd)&&Math.abs(row.long+row.short-row.total)<=1;
const distinct=(rows,id)=>new Set(rows.map(row=>row[id])).size===rows.length;

function validAssets(part,now){
  return part?.scope==='per-asset'&&timely(part.asOf,now)&&Array.isArray(part.rows)&&part.rows.length>0&&part.rows.length<=LIQUIDATION_ASSETS.length&&
    part.rows.every(row=>hasSides(row)&&LIQUIDATION_ASSETS.includes(row.symbol))&&distinct(part.rows,'symbol');
}
function validVenues(part,now){
  return part?.scope==='all-assets'&&timely(part.asOf,now)&&usd(part.total)&&Array.isArray(part.rows)&&part.rows.length>0&&part.rows.length<=32&&
    part.rows.every(row=>hasSides(row)&&typeof row.id==='string'&&/^[a-z][a-z0-9-]{0,35}$/.test(row.id))&&distinct(part.rows,'id')&&
    Math.abs(part.rows.reduce((sum,row)=>sum+row.total,0)-part.total)<=(part.rows.length+1)/2;
}
export function validMarginPadLiquidations(body,now=Date.now()){
  return body?.unit==='USD'&&body.windowHours===24&&Object.entries(SOURCE).every(([k,v])=>body.source?.[k]===v)&&
    (body.byAsset!==null||body.byVenue!==null)&&(body.byAsset===null||validAssets(body.byAsset,now))&&(body.byVenue===null||validVenues(body.byVenue,now));
}

function assetTotals(raw,now){
  const d=raw?.data;
  if(raw?.ok!==true||d?.src!=='own'||!Array.isArray(d.coins)||d.coins.length>1500)return null;
  const rows=d.coins.filter(row=>LIQUIDATION_ASSETS.includes(row?.s)).map(row=>({symbol:row.s,long:row.long,short:row.short,total:row.liq}));
  const part={scope:'per-asset',asOf:d.ts,rows};
  return validAssets(part,now)?part:null;
}
function venueTotals(raw,now){
  const d=raw?.data;
  if(raw?.ok!==true||d?.window!=='24h'||typeof d.source!=='string'||!d.source.startsWith('MarginPad liquidation collector')||!Array.isArray(d.venues)||d.venues.length>32)return null;
  const rows=d.venues.map(row=>({id:row?.venue,long:row?.long,short:row?.short,total:row?.total}));
  const part={scope:'all-assets',asOf:d.ts,total:d.total,rows};
  return validVenues(part,now)?part:null;
}

export function marginPadLiquidationsRequest(symbol){
  if(!LIQUIDATION_ASSETS.includes(symbol))return null;
  return {key:'derivatives:marginpad-liquidations:24h',resource:'derivatives',
    policy:{urls:['liquidations','venues'].map(path=>({url:API+path,optional:true,timeoutMs:5000})),parallel:true,
      interval:MINUTE,maxBytes:120_000,cacheKey:'marginpad-liquidations:24h:v1'},
    decode:([coins,venues],now)=>{
      // These are independent projections of the collector. Its two snapshots can have different timestamps.
      const body={source:{...SOURCE},unit:'USD',windowHours:24,byAsset:assetTotals(coins,now),byVenue:venueTotals(venues,now)};
      if(!validMarginPadLiquidations(body,now))throw Error('INVALID_MARGINPAD_LIQUIDATIONS');
      return body;
    }};
}
