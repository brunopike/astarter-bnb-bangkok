const BASE='https://ethereum-beacon-api.publicnode.com',HEADER=BASE+'/eth/v1/beacon/headers/finalized';
const GENESIS_MS=1606824023000,SLOT_MS=12000,EPOCH_SLOTS=32,EPOCH_MS=SLOT_MS*EPOCH_SLOTS,STALE=1800000,MAX_U64=18446744073709551615n;
const METHOD='https://lighthouse-book.sigmaprime.io/api_validator_inclusion.html';
const GWEI_KEYS=['current_epoch_active_gwei','current_epoch_target_attesting_gwei','previous_epoch_target_attesting_gwei','previous_epoch_head_attesting_gwei'];
const coverage=Object.freeze({scope:'ETHEREUM_ACTIVE_EFFECTIVE_BALANCE',network:'Ethereum mainnet',balanceBasis:'active_effective_gwei',finality:'provider_reported_finalized',actualPrincipal:false});
export const PUBLIC_ETH_ACTIVE_BALANCE_SOURCE=Object.freeze({url:HEADER,provider:'PublicNode',interval:EPOCH_MS,stale:STALE,maxBytes:10000,format:'text',headers:Object.freeze({Accept:'application/json'})});
const check=value=>{if(!value)throw Error('INVALID_ETH_ACTIVE_BALANCE');};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)||{},'value'));
const uint=value=>typeof value==='string'&&/^(?:0|[1-9]\d{0,19})$/.test(value)&&BigInt(value)<=MAX_U64;
const hash=value=>typeof value==='string'&&/^0x[0-9a-f]{64}$/.test(value);
const fixed=(value,expected)=>exact(value,Object.keys(expected))&&Object.keys(expected).every(key=>value[key]===expected[key]);
const clock=(receivedAt,startedAt,now)=>Number.isSafeInteger(now)&&now>0&&Number.isSafeInteger(receivedAt)&&receivedAt>0&&receivedAt<=now+1000&&Number.isSafeInteger(startedAt)&&startedAt>0&&startedAt<=receivedAt&&receivedAt-startedAt<=8000;
function eth(value){const gwei=BigInt(value),fraction=String(gwei%1000000000n).padStart(9,'0').replace(/0+$/,'');return String(gwei/1000000000n)+(fraction?'.'+fraction:'');}

// The pinned Node 24 runtime exposes the original numeric token to the native JSON reviver.
// Never recover an unsafe gwei integer from its already-rounded JavaScript Number.
function parse(text,gwei=false){
 check(typeof text==='string'&&text.length>0&&new TextEncoder().encode(text).length<=10000);
 try{return JSON.parse(text,(key,value,context)=>{
  if(gwei&&GWEI_KEYS.includes(key)&&typeof value==='number'){
   check(typeof context?.source==='string'&&uint(context.source));return context.source;
  }
  return value;
 });}catch{throw Error('INVALID_ETH_ACTIVE_BALANCE');}
}
function headerBinding(text,at){
 const body=parse(text),data=body?.data,header=data?.header,message=header?.message;
 check(exact(body,['execution_optimistic','finalized','data'])&&body.execution_optimistic===false&&body.finalized===true&&exact(data,['root','canonical','header'])&&data.canonical===true&&hash(data.root)&&exact(header,['message','signature'])&&/^0x[0-9a-f]{192}$/.test(header.signature||'')&&exact(message,['slot','proposer_index','parent_root','state_root','body_root'])&&uint(message.slot)&&uint(message.proposer_index)&&hash(message.parent_root)&&hash(message.state_root)&&hash(message.body_root));
 const finalizedSlot=Number(message.slot),epoch=Math.floor(finalizedSlot/EPOCH_SLOTS),sourceAsOf=GENESIS_MS+epoch*EPOCH_MS,slotTime=GENESIS_MS+finalizedSlot*SLOT_MS;
 check(Number.isSafeInteger(finalizedSlot)&&finalizedSlot>0&&Number.isSafeInteger(sourceAsOf+STALE)&&Number.isSafeInteger(slotTime)&&slotTime<=at+1000&&at<sourceAsOf+STALE);
 return {epoch,finalizedSlot,blockRoot:data.root,stateRoot:message.state_root,sourceAsOf};
}

// This is effective balance able to vote in the selected epoch, not actual staking principal.
export function normalizeEthActiveBalance(raw,receivedAt,requestStartedAt=receivedAt){
 check(clock(receivedAt,requestStartedAt,receivedAt)&&Array.isArray(raw)&&raw.length===2);
 const binding=headerBinding(raw[0],receivedAt),aggregate=parse(raw[1],true);
 check(exact(aggregate,['data'])&&exact(aggregate.data,GWEI_KEYS)&&GWEI_KEYS.every(key=>uint(aggregate.data[key])));
 const activeEffectiveGwei=aggregate.data.current_epoch_active_gwei;
 check(BigInt(activeEffectiveGwei)>0n&&BigInt(aggregate.data.current_epoch_target_attesting_gwei)<=BigInt(activeEffectiveGwei));
 return {schema:'eth-active-balance-v1',metric:'eth-active-balance',symbol:'ETH',unit:'ETH',source:'PublicNode',sourceUrl:BASE,methodUrl:METHOD,coverage:{...coverage},...binding,activeEffectiveGwei,activeEffectiveEth:eth(activeEffectiveGwei),requestStartedAt,receivedAt,validUntil:binding.sourceAsOf+STALE};
}

// Historical receipts remain inspectable after expiry, with their original source deadline.
export function validateEthActiveBalance(body,now=Date.now()){
 try{
  if(!exact(body,['schema','metric','symbol','unit','source','sourceUrl','methodUrl','coverage','epoch','finalizedSlot','blockRoot','stateRoot','sourceAsOf','activeEffectiveGwei','activeEffectiveEth','requestStartedAt','receivedAt','validUntil'])||body.schema!=='eth-active-balance-v1'||body.metric!=='eth-active-balance'||body.symbol!=='ETH'||body.unit!=='ETH'||body.source!=='PublicNode'||body.sourceUrl!==BASE||body.methodUrl!==METHOD||!fixed(body.coverage,coverage)||!clock(body.receivedAt,body.requestStartedAt,now)||!Number.isSafeInteger(body.finalizedSlot)||body.finalizedSlot<=0||!Number.isSafeInteger(body.epoch)||body.epoch!==Math.floor(body.finalizedSlot/EPOCH_SLOTS)||!hash(body.blockRoot)||!hash(body.stateRoot)||!uint(body.activeEffectiveGwei)||BigInt(body.activeEffectiveGwei)<=0n||body.activeEffectiveEth!==eth(body.activeEffectiveGwei))return false;
  const asOf=GENESIS_MS+body.epoch*EPOCH_MS,slotTime=GENESIS_MS+body.finalizedSlot*SLOT_MS;
  return Number.isSafeInteger(asOf+STALE)&&Number.isSafeInteger(slotTime)&&slotTime<=body.receivedAt+1000&&body.sourceAsOf===asOf&&body.validUntil===asOf+STALE&&body.receivedAt<body.validUntil;
 }catch{return false;}
}

export function publicEthActiveBalanceRequest(params){
 if(!(params instanceof URLSearchParams)||params.size!==0)return null;
 return {key:'eth-active-balance:mainnet',resource:'eth-active-balance',policy:PUBLIC_ETH_ACTIVE_BALANCE_SOURCE,async collect(load,now){
  const startedAt=now(),header=await load({url:HEADER,format:'text',maxBytes:10000}),binding=headerBinding(header,now());
  const aggregate=await load({url:BASE+'/lighthouse/validator_inclusion/'+binding.epoch+'/global',format:'text',maxBytes:10000});
  const body=normalizeEthActiveBalance([header,aggregate],now(),startedAt);check(validateEthActiveBalance(body,body.receivedAt));return body;
 }};
}
