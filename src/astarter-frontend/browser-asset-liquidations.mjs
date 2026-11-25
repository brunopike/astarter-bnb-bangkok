import {DERIVATIVE_SYMBOLS} from './public-market-extended.mjs';
const ORIGIN='https://swolecharts.com';
const HOUR=3_600_000,DAY=24*HOUR;
const COMPLETE=new Set(['bybit','gate','htx','lighter']);
const SAMPLED=new Set(['binance','bitget','aster']);
const amount=v=>Number.isFinite(v)&&v>=0&&Number.isSafeInteger(Math.round(v*100));
const count=v=>Number.isSafeInteger(v)&&v>=0;
const cents=v=>Math.round(v*100);
const sides=v=>v&&amount(v.long)&&amount(v.short)&&count(v.count)&&(v.count>0||v.long+v.short===0);
const requireData=ok=>{if(!ok)throw Error('INVALID_LIQUIDATION_WINDOW');};

// Rows, buckets and their totals are each rounded by the publisher to the nearest cent.
function reconciles(values,total){
  return Math.abs(values.reduce((sum,v)=>sum+cents(v),0)-cents(total))<=Math.floor((values.length+1)/2);
}

export function normalizeAssetVenueLiquidations(d,symbol,now=Date.now()){
  requireData(DERIVATIVE_SYMBOLS.includes(symbol)&&d?.coin===symbol&&d.window==='24h'&&d.source==='db'&&d.partial===false&&
    Number.isSafeInteger(d.since)&&Number.isSafeInteger(d.until)&&d.since>0&&d.until-d.since===DAY&&d.as_of===d.until&&
    d.as_of<=now+60_000&&now-d.as_of<=10*60_000&&sides(d)&&amount(d.total)&&reconciles([d.long,d.short],d.total));
  requireData(Array.isArray(d.coins)&&d.coins.length<=1&&(!d.count||d.coins.length===1));
  for(const row of d.coins)requireData(row?.base===symbol&&row.long===d.long&&row.short===d.short&&row.count===d.count);
  requireData(Array.isArray(d.venues)&&d.venues.length<=40&&(!d.count||d.venues.length>0));
  const seen=new Set();
  const rows=d.venues.map(row=>{
    requireData(sides(row)&&typeof row.venue==='string'&&/^[a-z][a-z0-9-]{0,31}$/.test(row.venue)&&!seen.has(row.venue));
    seen.add(row.venue);
    return {id:row.venue,long:row.long,short:row.short,count:row.count,
      coverage:COMPLETE.has(row.venue)?'complete':SAMPLED.has(row.venue)?'sampled':'unknown'};
  });
  requireData(rows.reduce((sum,row)=>sum+row.count,0)===d.count&&reconciles(rows.map(r=>r.long),d.long)&&reconciles(rows.map(r=>r.short),d.short));

  // The first and last buckets can be partial hours. Every UTC hour intersecting the window must be present.
  const b=d.buckets,first=Math.floor(d.since/HOUR)*HOUR,last=Math.floor((d.until-1)/HOUR)*HOUR;
  requireData(b?.step===HOUR&&Array.isArray(b.t)&&b.t.length>=24&&b.t.length<=25&&b.t[0]===first&&b.t.at(-1)>=last&&
    b.t.at(-1)<=d.until&&b.t.every((t,i)=>t===first+i*HOUR));
  for(const side of ['long','short'])requireData(Array.isArray(b[side])&&b[side].length===b.t.length&&b[side].every(amount)&&reconciles(b[side],d[side]));
  return {symbol,unit:'USD',asOf:d.as_of,start:d.since,scope:'asset-by-venue',
    source:{name:'Swolecharts',url:ORIGIN+'/liquidations/'+symbol+'/24h',coverageUrl:ORIGIN+'/coverage'},
    total:{long:d.long,short:d.short,count:d.count},rows};
}

export async function loadAssetVenueLiquidations(symbol,{signal,fetchImpl=globalThis.fetch}={}){
  if(!DERIVATIVE_SYMBOLS.includes(symbol))throw Error('INVALID_LIQUIDATION_ASSET');
  const response=await fetchImpl(ORIGIN+'/api/liquidations/window?window=24h&coin='+symbol,
    {signal,mode:'cors',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
  if(!response.ok)throw Error('LIQUIDATION_SOURCE_UNAVAILABLE');
  return normalizeAssetVenueLiquidations(await response.json(),symbol);
}
