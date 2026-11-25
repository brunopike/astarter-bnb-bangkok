const SATOSHIS=100000000n,MAX_MONEY=21000000n*SATOSHIS,STALE=1800000;
export const BTC_DISCLOSED_ADDRESSES=Object.freeze([
 'bc1qpy4jwethqenp4r7hqls660wy8287vw0my32lmy',
 '3LhhDLBVWBZChNQv8Dn4nDKFnCyojG1FqN',
 '3QsGsAXQ4rqRNvh5pEW55hf3F9PEyb7rVq',
 'bc1qr4dl5wa7kl8yu792dceg9z5knl2gkn220lk7a9',
 'bc1q4c8n5t00jmj8temxdgcc3t32nkg2wjwz24lywv',
 '14m3sd9HCCFJW4LymahJCKMabAxTK4DAqW'
]);
export const PUBLIC_BTC_DISCLOSED_SOURCE=Object.freeze({urls:Object.freeze(BTC_DISCLOSED_ADDRESSES.map(address=>'https://mempool.space/api/address/'+address)),provider:'mempool.space',interval:900000,stale:STALE,maxBytes:10000,parallel:true,format:'json',headers:Object.freeze({Accept:'application/json'})});
const disclosure=Object.freeze({organization:'Crypto.com',publishedOn:'2022-11-11',url:'https://crypto.com/en/company-news/transparency-first',attribution:'historical_self_disclosure',currentControlVerified:false});
const coverage=Object.freeze({scope:'DISCLOSED_ADDRESS_BALANCE_SAMPLE',addressCount:6,disclosedSetComplete:true,exchangeCoverageComplete:false,balanceBasis:'confirmed_utxos',timeBasis:'request_observation_window',netflowAvailable:false,netflowReason:'TRANSACTION_WINDOW_NOT_TRAVERSED'});
const check=value=>{if(!value)throw Error('INVALID_BTC_DISCLOSED_BALANCE');};
const count=value=>Number.isSafeInteger(value)&&value>=0;
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)||{},'value'));
const fixed=(value,expected)=>exact(value,Object.keys(expected))&&Object.keys(expected).every(key=>value[key]===expected[key]);
const amount=value=>typeof value==='string'&&/^(?:0|[1-9]\d{0,15})$/.test(value)&&BigInt(value)<=BigInt(Number.MAX_SAFE_INTEGER);
function btc(value){const whole=value/SATOSHIS,fraction=String(value%SATOSHIS).padStart(8,'0').replace(/0+$/,'');return String(whole)+(fraction?'.'+fraction:'');}
function clock(receivedAt,startedAt,now){return Number.isSafeInteger(now)&&now>0&&Number.isSafeInteger(receivedAt)&&receivedAt>0&&receivedAt<=now+1000&&receivedAt<=Number.MAX_SAFE_INTEGER-STALE&&Number.isSafeInteger(startedAt)&&startedAt>0&&startedAt<=receivedAt&&receivedAt-startedAt<=8000;}

// This is a historical self-disclosed address set, not an exchange-wide reserve or ownership assertion.
export function normalizeBtcDisclosedBalance(raw,receivedAt,requestStartedAt=receivedAt){
 check(clock(receivedAt,requestStartedAt,receivedAt)&&Array.isArray(raw)&&raw.length===BTC_DISCLOSED_ADDRESSES.length);
 const rows=BTC_DISCLOSED_ADDRESSES.map((address,index)=>{
  const body=raw[index],stats=body?.chain_stats;
  check(body?.address===address&&stats&&['funded_txo_count','funded_txo_sum','spent_txo_count','spent_txo_sum','tx_count'].every(key=>count(stats[key]))&&stats.spent_txo_sum<=stats.funded_txo_sum&&stats.spent_txo_count<=stats.funded_txo_count);
  const funded=BigInt(stats.funded_txo_sum),spent=BigInt(stats.spent_txo_sum),confirmed=funded-spent;check(confirmed<=MAX_MONEY);
  return {address,fundedSats:String(funded),spentSats:String(spent),confirmedSats:String(confirmed),confirmedBtc:btc(confirmed),confirmedTxCount:stats.tx_count,explorerUrl:'https://mempool.space/address/'+address};
 });
 const total=rows.reduce((sum,row)=>sum+BigInt(row.confirmedSats),0n);check(total<=MAX_MONEY);
 return {schema:'btc-disclosed-balance-v1',metric:'btc-disclosed-balance',symbol:'BTC',unit:'BTC',source:'mempool.space',sourceUrl:'https://mempool.space/docs/api/rest',disclosure:{...disclosure},coverage:{...coverage},requestStartedAt,receivedAt,validUntil:receivedAt+STALE,rows,totalConfirmedSats:String(total),totalConfirmedBtc:btc(total)};
}

// Expiration remains available to the caller; reading an old receipt never regenerates its deadline.
export function validateBtcDisclosedBalance(body,now=Date.now()){
 try{
  if(!exact(body,['schema','metric','symbol','unit','source','sourceUrl','disclosure','coverage','requestStartedAt','receivedAt','validUntil','rows','totalConfirmedSats','totalConfirmedBtc'])||body.schema!=='btc-disclosed-balance-v1'||body.metric!=='btc-disclosed-balance'||body.symbol!=='BTC'||body.unit!=='BTC'||body.source!=='mempool.space'||body.sourceUrl!=='https://mempool.space/docs/api/rest'||!fixed(body.disclosure,disclosure)||!fixed(body.coverage,coverage)||!clock(body.receivedAt,body.requestStartedAt,now)||body.validUntil!==body.receivedAt+STALE||!Array.isArray(body.rows)||body.rows.length!==6)return false;
  let total=0n;
  for(let index=0;index<6;index++){
   const row=body.rows[index],address=BTC_DISCLOSED_ADDRESSES[index];
   if(!exact(row,['address','fundedSats','spentSats','confirmedSats','confirmedBtc','confirmedTxCount','explorerUrl'])||row.address!==address||row.explorerUrl!=='https://mempool.space/address/'+address||!['fundedSats','spentSats','confirmedSats'].every(key=>amount(row[key]))||!count(row.confirmedTxCount))return false;
   const confirmed=BigInt(row.fundedSats)-BigInt(row.spentSats);if(confirmed<0n||confirmed>MAX_MONEY||row.confirmedSats!==String(confirmed)||row.confirmedBtc!==btc(confirmed))return false;total+=confirmed;
  }
  return total<=MAX_MONEY&&body.totalConfirmedSats===String(total)&&body.totalConfirmedBtc===btc(total);
 }catch{return false;}
}

export function publicBtcDisclosedRequest(params){
 if(!(params instanceof URLSearchParams)||params.size!==0)return null;
 return {key:'btc-disclosed-balance:cryptocom-20221111',resource:'btc-disclosed-balance',policy:PUBLIC_BTC_DISCLOSED_SOURCE,decode:(parts,at,startedAt)=>normalizeBtcDisclosedBalance(parts,at,startedAt)};
}
