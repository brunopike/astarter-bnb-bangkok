const HOUR=3_600_000;
const SOURCE=Object.freeze({
 name:'CryptoKeyhole',
 url:'https://cryptokeyhole.com/proof-of-reserves/',
 license:'CC BY 4.0',
 licenseUrl:'https://creativecommons.org/licenses/by/4.0/'
});
export const EXCHANGE_RESERVES_POLICY=Object.freeze({
 url:SOURCE.url,format:'text',headers:{Accept:'text/html'},maxBytes:500_000,
 interval:600_000,stale:3*HOUR,cacheKey:'exchange-reserves:proof-v2'
});

const check=value=>{if(!value)throw Error('INVALID_EXCHANGE_RESERVES');};
const text=html=>html.replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').trim();
const columns=['Exchange','Reserves','24 hours','7 days','Bitcoin','Ether','Stablecoins'];
const multipliers={'':1,K:1e3,M:1e6,B:1e9,T:1e12};
const safeBalance=value=>value===null||Number.isFinite(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER;
const missing=/^(?:—|–|-|&mdash;)$/;

function balance(value){
 if(missing.test(value))return null;
 const match=/^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([KMBT]?)$/.exec(value);
 check(match);
 return Number(match[1].replaceAll(',','')+(match[2]??''))*multipliers[match[3]];
}

function signedUsd(value){
 if(missing.test(value))return null;
 const field=/^([+−-]?)\$(.+)$/.exec(value);
 check(field);
 const parsed=balance(field[2]);
 if(parsed===null||parsed!==0&&!field[1])return null;
 const amount=Number(parsed.toFixed(2));
 return amount===0?0:field[1]==='+'?amount:-amount;
}

export function validateExchangeReserves(body,now=Date.now()){
 if(body?.scope!=='COVERED_EXCHANGE_ADDRESSES'||!Object.entries(SOURCE).every(([key,value])=>body.source?.[key]===value)||
  !Number.isSafeInteger(body.asOf)||body.asOf<=0||body.asOf%HOUR!==0||body.asOf>now+60_000||
  !Array.isArray(body.rows)||body.rows.length<1||body.rows.length>30)return false;
 const rows=body.rows;
 return rows.every(row=>typeof row?.slug==='string'&&/^[a-z0-9][a-z0-9-]{0,39}$/.test(row.slug)&&
  typeof row.name==='string'&&/^[A-Za-z0-9][A-Za-z0-9. ()_-]{0,59}$/.test(row.name)&&
  safeBalance(row.btc)&&safeBalance(row.eth)&&(row.btc!==null||row.eth!==null)&&
  [row.net24hUsd,row.net7dUsd].every(v=>v===null||Number.isFinite(v)&&Math.abs(v)<Number.MAX_SAFE_INTEGER))&&
  new Set(rows.map(row=>row.slug)).size===rows.length;
}

function decodeReserves(html,now){
 // Read the public, attributed table at the published hour. Its BTC and ETH figures are rounded upstream.
 const table=typeof html==='string'&&/<table\b[^>]*\baria-label="Reserves and net flows at (\d{2}:00) UTC on (\d{1,2}) ([A-Z][a-z]{2}) (\d{4})"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
 check(table);
 const [,clock,day,month,year,content]=table;
 const asOf=Date.parse(day+' '+month+' '+year+' '+clock+':00 GMT');
 check(Number.isFinite(asOf)&&new Date(asOf).getUTCDate()===Number(day));
 const thead=content.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1]??'';
 const heads=Array.from(thead.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi),match=>text(match[1]));
 check(heads.length===columns.length&&columns.every((name,i)=>name===heads[i]));
 const tbody=content.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1]??'';
 const rows=Array.from(tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi),match=>{
  const cells=Array.from(match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi),cell=>cell[1]);
  check(cells.length===columns.length);
  const slug=cells[0].match(/href="#([a-z0-9-]+)"/)?.[1];
  return {slug,name:text(cells[0]),btc:balance(text(cells[4])),eth:balance(text(cells[5])),
   net24hUsd:signedUsd(text(cells[2])),net7dUsd:signedUsd(text(cells[3]))};
 });
 const body={source:{...SOURCE},scope:'COVERED_EXCHANGE_ADDRESSES',asOf,rows};
 check(validateExchangeReserves(body,now));
 return body;
}

export function publicExchangeReservesRequest(params){
 if(params.size)return null;
 return {key:'exchange-reserves',resource:'exchange-reserves',policy:EXCHANGE_RESERVES_POLICY,decode:([html],now)=>decodeReserves(html,now)};
}
