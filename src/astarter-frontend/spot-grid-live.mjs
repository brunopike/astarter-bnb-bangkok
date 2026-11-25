import {createHmac} from 'node:crypto';
import {chmod,mkdir,open,readFile,rename} from 'node:fs/promises';
import path from 'node:path';

export const GRID_EPISODE={
 strategy:'S01',
 symbol:'BTCUSDT',
 pair:'BTC/USDT',
 maxOrders:4,
 minNotional:'5',
 totalBudget:'20',
 deadline:'2026-11-23T15:59:59.999Z',
 withdraw:false,
 executionAuthority:'NONE'
};
const HOST='https://api.binance.com';
const SCALE=100000000n;

function fail(code){throw Object.assign(Error(code),{code});}
function scaled(value){
 const text=typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):'';
 if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text))return null;
 const [whole,frac='']=text.split('.');
 return BigInt(whole)*SCALE+BigInt((frac+'00000000').slice(0,8));
}
function text(value){
 const negative=value<0n,raw=negative?-value:value;
 const whole=raw/SCALE,frac=(raw%SCALE).toString().padStart(8,'0').replace(/0+$/,'');
 return `${negative?'-':''}${whole.toString()}${frac?`.${frac}`:''}`;
}
function floorTo(value,step){return value/step*step;}
function ceilTo(value,step){return (value+step-1n)/step*step;}
export function planGrid({close,atr,bid,tick='0.01',step='0.00001',minNotional=GRID_EPISODE.minNotional,budget=GRID_EPISODE.totalBudget}={}){
 const closeN=scaled(close),atrN=scaled(atr),bidN=scaled(bid),tickN=scaled(tick),stepN=scaled(step),minN=scaled(minNotional),budgetN=scaled(budget);
 if([closeN,atrN,bidN,tickN,stepN,minN,budgetN].some(value=>value===null)||closeN<=0n||bidN<=0n||tickN<=0n||stepN<=0n||minN<=0n||budgetN<=0n)return [];
 const width=closeN*4n/1000n>atrN/2n?closeN*4n/1000n:atrN/2n;
 const cap=floorTo(bidN-tickN,tickN);
 const orders=[];
 let spent=0n;
 for(let level=1;level<=GRID_EPISODE.maxOrders;level++){
  let price=floorTo(closeN-width*BigInt(level),tickN);
  if(price>cap)price=cap;
  if(price<=0n)continue;
  const qty=ceilTo((minN*SCALE+price-1n)/price,stepN);
  const notional=price*qty/SCALE;
  if(qty<=0n||notional<minN||spent+notional>budgetN)continue;
  orders.push({level,price:text(price),quantity:text(qty),notional:text(notional),clientOrderId:`astarter-s01-20261121-${level}`});
  spent+=notional;
 }
 return orders;
}
async function readBody(response){
 const raw=await response.text();
 if(raw.length>1000000)fail('INVALID_RESPONSE');
 try{return JSON.parse(raw);}catch{fail('INVALID_RESPONSE');}
}
async function signed(method,pathname,params,creds,fetchImpl){
 const clock=await readBody(await fetchImpl(HOST+'/api/v3/time',{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)}));
 if(!Number.isFinite(clock.serverTime))fail('INVALID_RESPONSE');
 const query=new URLSearchParams();
 for(const [key,value] of Object.entries(params))query.set(key,String(value));
 query.set('timestamp',String(clock.serverTime));
 query.set('recvWindow','5000');
 query.set('signature',createHmac('sha256',creds.secret).update(query.toString()).digest('hex'));
 const response=await fetchImpl(HOST+pathname+'?'+query,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json','X-MBX-APIKEY':creds.key}});
 const data=await readBody(response);
 if(data&&typeof data.code==='number'&&data.code!==0)throw Object.assign(Error('EXCHANGE_REJECTED'),{code:'EXCHANGE_REJECTED',exchangeCode:data.code});
 if(!response.ok)fail('UPSTREAM_UNAVAILABLE');
 return data;
}
function withdrawOn(restrictions){
 return restrictions.enableWithdrawals===true||restrictions.permitsUniversalTransfer===true||restrictions.enableInternalTransfer===true;
}
async function writeReceipt(receiptPath,receipt){
 const dir=path.dirname(receiptPath),tmp=receiptPath+'.tmp';
 await mkdir(dir,{recursive:true,mode:0o700});
 const handle=await open(tmp,'w',0o600);
 try{await handle.writeFile(JSON.stringify(receipt),'utf8');await handle.sync();}finally{await handle.close();}
 await chmod(tmp,0o600);
 await rename(tmp,receiptPath);
}
function publicReceipt(orders){
 const spent=orders.reduce((sum,order)=>sum+(scaled(order.notional)||0n),0n);
 return {schema:'s01-grid-receipt-v1',strategy:'S01',symbol:'BTCUSDT',status:orders.length?'placed':'empty',orders,orderCount:orders.length,totalNotional:text(spent),budget:GRID_EPISODE.totalBudget,withdraw:false,executionAuthority:'NONE'};
}
export async function runSpotGrid({creds,fetchImpl,now=Date.now(),receiptPath,confirm}={}){
 if(confirm!=='once')fail('CONFIRM_REQUIRED');
 if(!creds?.key||!creds?.secret||creds.key.length<8||creds.secret.length<8)fail('CREDENTIALS_MISSING');
 if(now>Date.parse(GRID_EPISODE.deadline))fail('DEADLINE');
 let existing=null;
 try{existing=JSON.parse(await readFile(receiptPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(existing?.orders?.length)return publicReceipt(existing.orders);
 const info=await readBody(await fetchImpl(`${HOST}/api/v3/exchangeInfo?symbol=${GRID_EPISODE.symbol}`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)}));
 const symbol=info.symbols?.find(row=>row.symbol===GRID_EPISODE.symbol);
 const notional=symbol?.filters?.find(row=>row.filterType==='NOTIONAL')?.minNotional;
 const tick=symbol?.filters?.find(row=>row.filterType==='PRICE_FILTER')?.tickSize;
 const step=symbol?.filters?.find(row=>row.filterType==='LOT_SIZE')?.stepSize;
 if(symbol?.status!=='TRADING'||!notional||!tick||!step)fail('EXCHANGE_MINIMUM');
 const restrictions=await signed('GET','/sapi/v1/account/apiRestrictions',{},creds,fetchImpl);
 const account=await signed('GET','/api/v3/account',{},creds,fetchImpl);
 const usdt=account.balances?.find(row=>row.asset==='USDT');
 if(withdrawOn(restrictions)||account.canTrade!==true&&restrictions.enableSpotAndMarginTrading!==true)fail('WITHDRAW_OR_TRADE');
 if(!usdt||scaled(usdt.free)<scaled(GRID_EPISODE.totalBudget))fail('BALANCE');
 const candles=await readBody(await fetchImpl(`${HOST}/api/v3/klines?symbol=${GRID_EPISODE.symbol}&interval=1h&limit=48`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)}));
 const book=await readBody(await fetchImpl(`${HOST}/api/v3/ticker/bookTicker?symbol=${GRID_EPISODE.symbol}`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)}));
 if(!Array.isArray(candles)||candles.length<16)fail('MARKET_DATA');
 const closed=candles.slice(0,-1);
 let atr=0n,count=0n;
 for(let index=closed.length-14;index<closed.length;index++){
  const high=scaled(closed[index][2]),low=scaled(closed[index][3]),prev=scaled(closed[index-1][4]);
  const range=[high-low,high>prev?high-prev:prev-high,low>prev?low-prev:prev-low].sort((a,b)=>a<b?-1:1).at(-1);
  atr+=range;count+=1n;
 }
 const plan=planGrid({close:closed.at(-1)[4],atr:text(atr/count),bid:book.bidPrice,tick,step,minNotional:notional});
 if(!plan.length)fail('NO_LEVEL');
 const placed=[];
 for(const order of plan){
  let response=null;
  try{response=await signed('GET','/api/v3/order',{symbol:GRID_EPISODE.symbol,origClientOrderId:order.clientOrderId},creds,fetchImpl);}
  catch(error){if(error.exchangeCode!==-2013){await writeReceipt(receiptPath,publicReceipt(placed));throw error;}}
  if(!response){
   try{response=await signed('POST','/api/v3/order',{symbol:GRID_EPISODE.symbol,side:'BUY',type:'LIMIT_MAKER',price:order.price,quantity:order.quantity,newClientOrderId:order.clientOrderId,newOrderRespType:'RESULT'},creds,fetchImpl);}
   catch(error){await writeReceipt(receiptPath,publicReceipt(placed));throw error;}
  }
  placed.push({...order,orderId:response.orderId,status:response.status,executedQty:response.executedQty||'0'});
 }
 const receipt=publicReceipt(placed);
 await writeReceipt(receiptPath,receipt);
 return receipt;
}

if(process.argv[1]&&import.meta.url.endsWith(process.argv[1].replaceAll('\\','/'))){
 const {homedir}=await import('node:os');
 runSpotGrid({creds:{key:process.env.BINANCE_API_KEY||'',secret:process.env.BINANCE_API_SECRET||''},fetchImpl:globalThis.fetch,receiptPath:process.env.ASTARTER_GRID_RECEIPT||path.join(homedir(),'.config/astarter/s01-grid-receipt.json'),confirm:process.argv.includes('--confirm-once')?'once':''}).then(receipt=>{process.stdout.write(JSON.stringify(receipt)+'\n');},error=>{process.stdout.write(JSON.stringify({ok:false,error:error.code||'ORDER_FAILED',exchangeCode:Number.isInteger(error.exchangeCode)?error.exchangeCode:undefined,executionAuthority:'NONE'})+'\n');process.exitCode=1;});
}
