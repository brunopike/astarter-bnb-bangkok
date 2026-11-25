// Public reference data only. These flags never grant vault, model or wallet authority.
export const WEALTH_MARKET_ASSETS=Object.freeze({usdc:Object.freeze({symbol:'USDC',decimals:6}),usdt:Object.freeze({symbol:'USDT',decimals:6}),weth:Object.freeze({symbol:'WETH',decimals:18}),wbtc:Object.freeze({symbol:'WBTC',decimals:8})});
export const WEALTH_MARKET_SCHEMA='wealth-public-market-v1';
export const WEALTH_MARKET_CAPABILITIES=Object.freeze({readOnly:true,realFundingEnabled:false,testFundingEnabled:false,modelEnabled:false,trackingEnabled:false});
const POOL='0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const ERRORS=new Set(['MARKET_UNAVAILABLE','MARKET_TIMEOUT','MARKET_RATE_LIMITED','MARKET_INVALID','MARKET_STALE','WRONG_CHAIN']);
const fault=code=>{throw Object.assign(Error(code),{code});};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const plain=value=>value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype;
function exact(value,keys){if(!plain(value)||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')))fault('MARKET_INVALID');}
export const wealthMarketAsset=value=>typeof value==='string'&&Object.hasOwn(WEALTH_MARKET_ASSETS,value);
export function wealthMarketFailure(assetId,error='MARKET_UNAVAILABLE'){
 if(!wealthMarketAsset(assetId))fault('SELECTION');
 return {schema:WEALTH_MARKET_SCHEMA,mode:'cloud-readonly',...WEALTH_MARKET_CAPABILITIES,assetId,status:'unavailable',error:ERRORS.has(error)?error:'MARKET_UNAVAILABLE',observation:null};
}
export function validateWealthPublicMarket(value,assetId,at=Date.now()){
 exact(value,['schema','mode',...Object.keys(WEALTH_MARKET_CAPABILITIES),'assetId','status','error','observation']);
 if(!integer(at)||!wealthMarketAsset(assetId)||value.assetId!==assetId||value.schema!==WEALTH_MARKET_SCHEMA||value.mode!=='cloud-readonly'||Object.entries(WEALTH_MARKET_CAPABILITIES).some(([key,expected])=>value[key]!==expected))fault('MARKET_INVALID');
 if(value.status==='unavailable'){
  if(!ERRORS.has(value.error)||value.observation!==null)fault('MARKET_INVALID');return structuredClone(value);
 }
 if(value.status!=='observed'||value.error!==null)fault('MARKET_INVALID');
 const o=value.observation;
 exact(o,['id','kind','status','provider','assetId','chainId','blockNumber','blockHash','asOf','receivedAt','expiresAt','reserveUpdatedAt','aprPercent','aprBps','availableLiquidityUnits','active','frozen','paused','url','contractUrl','admission']);
 if(o.kind!=='market'||o.status!=='observed'||o.provider!=='Aave V3 · Ethereum'||o.assetId!==assetId||o.chainId!==1||typeof o.blockNumber!=='string'||!/^[1-9]\d{0,77}$/.test(o.blockNumber)||BigInt(o.blockNumber)>=(1n<<256n)||o.id!=='aave-1-'+assetId+'-'+o.blockNumber||typeof o.blockHash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(o.blockHash)||/^0x0{64}$/i.test(o.blockHash)||o.admission!=='research_only'||o.url!=='https://etherscan.io/block/'+o.blockNumber||o.contractUrl!=='https://etherscan.io/address/'+POOL)fault('MARKET_INVALID');
 if(!['asOf','receivedAt','expiresAt','reserveUpdatedAt'].every(key=>integer(o[key]))||o.asOf%1000!==0||o.reserveUpdatedAt>o.asOf||o.expiresAt!==o.asOf+300000||o.receivedAt<o.asOf-30000)fault('MARKET_INVALID');
 if(o.asOf>at+30000||o.receivedAt>at+30000||at-o.asOf>180000||o.receivedAt-o.asOf>180000||o.expiresAt<=at)fault('MARKET_STALE');
 if(typeof o.availableLiquidityUnits!=='string'||!/^(?:0|[1-9]\d{0,77})$/.test(o.availableLiquidityUnits)||BigInt(o.availableLiquidityUnits)>=(1n<<256n)||!['active','frozen','paused'].every(key=>typeof o[key]==='boolean')||typeof o.aprPercent!=='string'||!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,6})?$/.test(o.aprPercent)||Number(o.aprPercent)>10000||!integer(o.aprBps)||o.aprBps>1000000)fault('MARKET_INVALID');
 const [whole,fraction='']=o.aprPercent.split('.'),scaled=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
 if(scaled/10000n!==BigInt(o.aprBps))fault('MARKET_INVALID');
 return structuredClone(value);
}
