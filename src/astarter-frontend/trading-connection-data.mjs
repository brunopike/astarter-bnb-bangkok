import {CONNECTION_OPTIONS,WALLET_NETWORKS} from './connection-options.mjs';

// Card A1 trading-connection-v1 DTOs. These checks do not authenticate an owner, store or read a
// credential, call a venue or grant any execution or withdrawal right. A state check without the owner fails.
const INPUT='PRIVATE_REQUEST_INVALID',OUTPUT='PRIVATE_UI_PROTOCOL';
const MAX_MILLIS=253402300799999;
const SECRET=/\bBearer\s+[A-Za-z0-9._-]{16,}|\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{16,}|(?:https?|postgres(?:ql)?):\/\/[^\s/@:]+:[^\s/@]+@|\b0x[0-9a-fA-F]{64}\b/;
const KEYLIKE=/^(?:sk[-_]|rk[-_]|AIza|gh[pousr]_|Bearer\s)|^(?:0x)?[a-f\d]{64}$/i;
const CEX=CONNECTION_OPTIONS.exchange.filter(option=>!option.wallet).map(option=>option.id),DEX=['wallet','hyperliquid'];
const CHAINS=WALLET_NETWORKS.map(network=>network.id),EVM=WALLET_NETWORKS.filter(network=>network.family==='evm').map(network=>network.id);
export const CONNECTION_STATUSES=['unchecked','connected','disconnected','denied','expired'];
export const CONNECTION_CHECK_CODES=['withdraw','permissions','ip','timeout','refused','network','unconfigured','unsupported','unavailable'];
const CONFIGURATION_KEYS=['connectionId','venue','venueType','market','chain','label','permissions'];
const RECORD_KEYS=[...CONFIGURATION_KEYS,'accountId','status','checkedAt','checkCode','checkSource','credentialRef'];
const CHECK_KEYS=['schema','connectionId','status','code','permissions','withdrawalsEnabled','balances','checkedAt','source','executionAuthority'];
const fail=code=>{throw Object.assign(Error(code),{code,status:code===INPUT?400:502});};
const check=(value,code)=>{if(!value)fail(code);};
const integer=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const millis=value=>integer(value,MAX_MILLIS);
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&[...value].length<=max&&!/[\u0000-\u001f\u007f<>]/.test(value)&&!SECRET.test(value)&&!KEYLIKE.test(value.trim())&&(!value.isWellFormed||value.isWellFormed());
const requestId=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{8,96}$/.test(value)&&!SECRET.test(value);
const connectionId=value=>typeof value==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,79}$/.test(value)&&!SECRET.test(value)&&!KEYLIKE.test(value);
const reference=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/.test(value)&&!SECRET.test(value)&&!KEYLIKE.test(value);
const decimal=value=>typeof value==='string'&&value.length<=64&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
const preferenceKey=value=>typeof value==='string'&&(['cex-spot','cex-perp'].includes(value)||['dex-spot','dex-perp'].some(profile=>CHAINS.some(chain=>value===profile+':'+chain)));
function exact(value,keys,code){
 check(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,code);
 const descriptors=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(descriptors);
 check(own.length===keys.length&&own.every(key=>typeof key==='string'&&keys.includes(key)&&Object.hasOwn(descriptors[key],'value')&&descriptors[key].enumerable),code);
}
function list(value,max,code){
 check(Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype&&value.length<=max,code);
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
 check(keys.length===value.length+1&&keys.every(key=>key==='length'||typeof key==='string'&&/^(?:0|[1-9]\d*)$/.test(key)&&Number(key)<value.length&&Object.hasOwn(descriptors[key],'value')&&descriptors[key].enumerable),code);
}
function scope(value,ownerRef,code){check(typeof value==='string'&&/^[A-Za-z0-9:._-]{1,128}$/.test(value)&&!SECRET.test(value)&&value===ownerRef,code);}
function result(value,limit,code){check(new TextEncoder().encode(JSON.stringify(value)).byteLength<=limit,code);return structuredClone(value);}
// Withdrawal is not a permission of this contract: only read, plus trade (CEX) or
// per-trade confirmation (wallet).
function permissions(value,venueType,code){
 list(value,2,code);check(value[0]==='read'&&(value.length===1||value[1]===(venueType==='CEX'?'trade':'confirm')),code);
}
function configuration(value,code){
 check(connectionId(value.connectionId)&&['CEX','DEX'].includes(value.venueType)&&['spot','perp'].includes(value.market)&&text(value.label,40),code);
 if(value.venueType==='CEX')check(CEX.includes(value.venue)&&value.chain==='',code);
 else check(DEX.includes(value.venue)&&(value.venue==='hyperliquid'?EVM:CHAINS).includes(value.chain)&&value.market===(value.venue==='hyperliquid'?'perp':'spot'),code);
 permissions(value.permissions,value.venueType,code);
}
function record(value,code){
 exact(value,RECORD_KEYS,code);configuration(value,code);
 check(text(value.accountId,64)&&CONNECTION_STATUSES.includes(value.status)&&(value.checkedAt===null||millis(value.checkedAt))&&(value.checkCode===null||CONNECTION_CHECK_CODES.includes(value.checkCode))&&[null,'synthetic','venue'].includes(value.checkSource)&&(value.credentialRef===null||reference(value.credentialRef)),code);
 // A record never claims a check it cannot show: a verdict needs a time and a source.
 check((value.checkedAt===null)===(value.checkSource===null)&&(!['connected','denied','expired'].includes(value.status)||value.checkedAt!==null)&&(value.status!=='connected'||value.checkCode===null)&&(value.status!=='denied'||value.checkCode!==null),code);
 // Only a reference to a server-side credential may appear. A venue check of an
 // exchange key needs one; a wallet connection never has one.
 check(value.venueType==='CEX'?value.checkSource!=='venue'||value.credentialRef!==null:value.credentialRef===null,code);
}
function receipt(value,code){
 exact(value,CHECK_KEYS,code);
 check(value.schema==='trading-connection-check-v1'&&connectionId(value.connectionId)&&['connected','denied','unchecked'].includes(value.status)&&(value.code===null||CONNECTION_CHECK_CODES.includes(value.code))&&[true,false,null].includes(value.withdrawalsEnabled)&&millis(value.checkedAt)&&['synthetic','venue'].includes(value.source)&&value.executionAuthority==='NONE',code);
 list(value.permissions,2,code);check(value.permissions.every(item=>['read','trade','confirm'].includes(item))&&new Set(value.permissions).size===value.permissions.length,code);
 list(value.balances,50,code);const assets=new Set();
 for(const row of value.balances){exact(row,['asset','free','locked'],code);check(typeof row.asset==='string'&&/^[A-Z0-9]{1,24}$/.test(row.asset)&&decimal(row.free)&&decimal(row.locked)&&!assets.has(row.asset),code);assets.add(row.asset);}
 // Connected needs read observed and withdrawals observed off. Any other result carries a code and no balances.
 check(value.status==='connected'?value.code===null&&value.withdrawalsEnabled===false&&value.permissions.includes('read'):value.code!==null&&value.balances.length===0,code);
 check((value.withdrawalsEnabled===true)===(value.code==='withdraw')&&(value.code!=='withdraw'||value.status==='denied'),code);
}

export function validateTradingConnectionCommand(value){
 exact(value,['requestId','baseRevision','action','payload'],INPUT);check(requestId(value.requestId)&&integer(value.baseRevision),INPUT);
 const payload=value.payload;
 if(value.action==='save'){exact(payload,CONFIGURATION_KEYS,INPUT);configuration(payload,INPUT);}
 else if(value.action==='prefer'){exact(payload,['key','connectionId'],INPUT);check(preferenceKey(payload.key)&&connectionId(payload.connectionId),INPUT);}
 else{check(['verify','disconnect'].includes(value.action),INPUT);exact(payload,['connectionId'],INPUT);check(connectionId(payload.connectionId),INPUT);}
 return result(value,16384,INPUT);
}
export function validateTradingConnectionState(value,ownerRef){
 exact(value,['schema','scope','revision','updatedAt','connections','preferences','executionAuthority'],OUTPUT);
 check(value.schema==='trading-connections-v1'&&integer(value.revision)&&millis(value.updatedAt)&&value.executionAuthority==='NONE',OUTPUT);scope(value.scope,ownerRef,OUTPUT);
 list(value.connections,20,OUTPUT);const ids=new Set();
 for(const item of value.connections){record(item,OUTPUT);check(!ids.has(item.connectionId),OUTPUT);ids.add(item.connectionId);}
 // A preference may point at a record that is gone or changed. It is kept as stored so
 // the client asks for a new choice; nothing here selects another record.
 list(value.preferences,10,OUTPUT);const keys=new Set();
 for(const item of value.preferences){exact(item,['key','connectionId'],OUTPUT);check(preferenceKey(item.key)&&connectionId(item.connectionId)&&!keys.has(item.key),OUTPUT);keys.add(item.key);}
 return result(value,65536,OUTPUT);
}
export function validateTradingConnectionCheck(value){receipt(value,OUTPUT);return result(value,16384,OUTPUT);}
export function validateTradingConnectionCommandResult(value,id,ownerRef){
 check(requestId(id),OUTPUT);exact(value,['request','state','check'],OUTPUT);
 const r=value.request;exact(r,['schema','domain','requestId','status','baseRevision','revision','appliedAt'],OUTPUT);
 check(r.schema==='private-ui-command-v1'&&r.domain==='connections'&&r.requestId===id&&r.status==='applied'&&integer(r.baseRevision)&&integer(r.revision)&&r.revision>=r.baseRevision&&millis(r.appliedAt),OUTPUT);
 const state=validateTradingConnectionState(value.state,ownerRef);check(state.revision===r.revision&&state.updatedAt<=r.appliedAt,OUTPUT);
 if(value.check!==null){
  receipt(value.check,OUTPUT);const saved=state.connections.find(item=>item.connectionId===value.check.connectionId);
  // The receipt and the record report the same check, and a connected record lists only observed permissions.
  check(saved&&saved.status===value.check.status&&saved.checkedAt===value.check.checkedAt&&saved.checkCode===value.check.code&&saved.checkSource===value.check.source&&value.check.checkedAt<=r.appliedAt&&(saved.status!=='connected'||saved.permissions.every(item=>value.check.permissions.includes(item))),OUTPUT);
 }
 return result(value,65536,OUTPUT);
}
