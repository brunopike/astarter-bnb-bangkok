// Public GET https://data-api.binance.vision/api/v3/depth?symbol={BTC|ETH|SOL}USDT&limit=100.
// These are request observation times, not exchange event timestamps. No network or order authority lives here.
const SYMBOLS=new Set(['BTC','ETH','SOL']);
const TTL=30000,MAX_RTT=8000;
export const SPOT_DEPTH_CLOCK_SKEW_MS=1000;
const DECIMAL=/^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const invalid=()=>{throw Error('INVALID_SPOT_DEPTH');};
const timestamp=value=>Number.isSafeInteger(value)&&value>=0;

function decimal(value){
 if(typeof value!=='string'||!DECIMAL.test(value))invalid();
 const number=Number(value);
 if(!Number.isFinite(number)||number<=0)invalid();
 return number;
}

function side(levels,bid){
 if(!Array.isArray(levels)||levels.length<1||levels.length>100)invalid();
 let previous;
 return Array.from(levels,level=>{
  if(!Array.isArray(level)||level.length!==2)invalid();
  const price=decimal(level[0]),quantity=decimal(level[1]),notional=price*quantity;
  if(!Number.isFinite(notional)||notional<=0||previous!==undefined&&(bid?price>=previous:price<=previous))invalid();
  previous=price;
  return {price,notional,raw:[level[0],level[1]]};
 });
}

function total(levels,within){
 const value=levels.reduce((sum,level)=>sum+(within(level.price)?level.notional:0),0);
 if(!Number.isFinite(value))invalid();
 return value;
}

export function normalizeSpotDepth(raw,symbol,times){
 const {requestStartedAt,receivedAt}=times??{};
 if(!SYMBOLS.has(symbol)||!raw||typeof raw!=='object'||Array.isArray(raw)||!Number.isSafeInteger(raw.lastUpdateId)||raw.lastUpdateId<0||!timestamp(requestStartedAt)||!timestamp(receivedAt)||receivedAt<requestStartedAt||receivedAt-requestStartedAt>MAX_RTT||!timestamp(requestStartedAt+TTL))invalid();
 const bids=side(raw.bids,true),asks=side(raw.asks,false);
 const bestBid=bids[0].price,bestAsk=asks[0].price;
 if(bestBid>=bestAsk)invalid();
 const mid=bestBid+(bestAsk-bestBid)/2,spreadBps=(bestAsk-bestBid)/mid*10000;
 const lower=mid*.99,upper=mid*1.01;
 if(![mid,spreadBps,lower,upper].every(Number.isFinite)||mid<=0||lower<=0||spreadBps<=0)invalid();
 return {
  schema:'spot-depth-v1',symbol,market:symbol+'/USDT',source:'Binance Spot',unit:'USDT',methodVersion:'spot-depth-100-v1',
  requestStartedAt,receivedAt,validUntil:requestStartedAt+TTL,lastUpdateId:raw.lastUpdateId,
  bestBid,bestAsk,mid,spreadBps,
  bidNotional:total(bids,price=>price>=lower),askNotional:total(asks,price=>price<=upper),
  bidCoverageComplete:bids.at(-1).price<=lower,askCoverageComplete:asks.at(-1).price>=upper,
  bidLevels:bids.length,askLevels:asks.length,bids:bids.map(level=>level.raw),asks:asks.map(level=>level.raw)
 };
}

export function validateSpotDepthSnapshot(snapshot,symbol,nowMs){
 if(!snapshot||typeof snapshot!=='object'||!timestamp(nowMs))invalid();
 const verified=normalizeSpotDepth(snapshot,symbol,snapshot);
 // Check the fixed source identity and every derived value, never repair a received DTO silently.
 for(const key of Object.keys(verified))if(key!=='bids'&&key!=='asks'&&snapshot[key]!==verified[key])invalid();
 // Independent server/client clocks may differ slightly; keep every source time and expiry unchanged.
 if(verified.receivedAt-nowMs>SPOT_DEPTH_CLOCK_SKEW_MS)invalid();
 if(nowMs>=verified.validUntil)throw Error('STALE_SPOT_DEPTH');
 return verified;
}
