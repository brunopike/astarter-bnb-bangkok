export const executionAuthorization=Object.freeze({
 schema:'execution-authorization-v1',
 venue:'binance',
 market:'spot',
 connectionId:'binance-spot',
 accountId:'BINANCE-SPOT',
 pair:'BTC/USDT',
 symbol:'BTCUSDT',
 maxNotional:'5',
 notionalAsset:'USDT',
 deadline:'2026-11-23T15:59:59.999Z',
 withdraw:false,
 ordersEnabled:false,
 executionAuthority:'NONE'
});

function decimal(value){
 const text=typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):'';
 if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text))return null;
 const [whole,frac='']=text.split('.');
 return {whole,frac:frac.replace(/0+$/,'')};
}
function compareDecimal(left,right){
 const a=decimal(left),b=decimal(right);
 if(!a||!b)return null;
 const width=Math.max(a.frac.length,b.frac.length);
 const as=BigInt(a.whole+a.frac.padEnd(width,'0')),bs=BigInt(b.whole+b.frac.padEnd(width,'0'));
 return as<bs?-1:as>bs?1:0;
}
export function mandateMatches(order,now=Date.now()){
 if(!order||typeof order!=='object'||Array.isArray(order))return false;
 if(order.connectionId!==executionAuthorization.connectionId)return false;
 if(order.accountId!==executionAuthorization.accountId)return false;
 if(order.venue!==executionAuthorization.venue||order.market!==executionAuthorization.market)return false;
 if(order.symbol!==executionAuthorization.symbol||order.pair!==executionAuthorization.pair)return false;
 if(order.notionalAsset!==executionAuthorization.notionalAsset)return false;
 if(order.withdraw!==false)return false;
 const amount=compareDecimal(order.notional,executionAuthorization.maxNotional);
 if(amount===null||amount>0)return false;
 if(compareDecimal(order.notional,'0')!==1)return false;
 if(!Number.isFinite(now)||now>Date.parse(executionAuthorization.deadline))return false;
 return executionAuthorization.executionAuthority==='NONE'&&executionAuthorization.withdraw===false;
}
export function liveOrderAllowed(){
 return false;
}
