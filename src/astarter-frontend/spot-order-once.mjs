import {createHmac} from 'node:crypto';
import {chmod,mkdir,open,readFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {executionAuthorization,mandateMatches} from './execution-authorization.mjs';

export const REQUEST_ID='astarter-btc-5-20261121';
const HOST='https://api.binance.com';

function fail(code){throw Object.assign(Error(code),{code});}
function scale(value){
 const text=typeof value==='number'&&Number.isFinite(value)?String(value):typeof value==='string'?value.trim():'';
 if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text))return null;
 const [whole,frac='']=text.split('.');
 return {whole,frac};
}
function compareDecimal(left,right){
 const a=scale(left),b=scale(right);
 if(!a||!b)return null;
 const width=Math.max(a.frac.length,b.frac.length);
 const as=BigInt(a.whole+a.frac.padEnd(width,'0')),bs=BigInt(b.whole+b.frac.padEnd(width,'0'));
 return as<bs?-1:as>bs?1:0;
}
function addDecimal(left,right){
 const a=scale(left),b=scale(right);
 if(!a||!b)return null;
 const width=Math.max(a.frac.length,b.frac.length);
 const total=BigInt(a.whole+a.frac.padEnd(width,'0'))+BigInt(b.whole+b.frac.padEnd(width,'0'));
 if(!width)return total.toString();
 const text=total.toString().padStart(width+1,'0');
 const whole=text.slice(0,-width).replace(/^0+(?=\d)/,'');
 const frac=text.slice(-width).replace(/0+$/,'');
 return frac?`${whole}.${frac}`:whole;
}
function intent(){
 return {connectionId:executionAuthorization.connectionId,accountId:executionAuthorization.accountId,venue:executionAuthorization.venue,market:executionAuthorization.market,pair:executionAuthorization.pair,symbol:executionAuthorization.symbol,notional:executionAuthorization.maxNotional,notionalAsset:executionAuthorization.notionalAsset,withdraw:false};
}
function orderParams(){
 return {symbol:executionAuthorization.symbol,side:'BUY',type:'MARKET',quoteOrderQty:executionAuthorization.maxNotional,newClientOrderId:REQUEST_ID,newOrderRespType:'FULL'};
}
async function readBody(response){
 const text=await response.text();
 if(text.length>1000000)fail('INVALID_RESPONSE');
 try{return JSON.parse(text);}catch{fail('INVALID_RESPONSE');}
}
async function signed(method,pathname,params,creds,fetchImpl){
 const clockResponse=await fetchImpl(HOST+'/api/v3/time',{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)});
 const clock=await readBody(clockResponse);
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
export function reconcileFill(order,trades){
 if(!order||order.symbol!==executionAuthorization.symbol||order.side!=='BUY'||order.type!=='MARKET'||order.clientOrderId!==REQUEST_ID)return null;
 if(order.status!=='FILLED'||!Array.isArray(order.fills)||!order.fills.length||!Array.isArray(trades))return null;
 if(compareDecimal(order.cummulativeQuoteQty,executionAuthorization.maxNotional)===1)return null;
 if(compareDecimal(order.cummulativeQuoteQty,'0')!==1)return null;
 const quote=trades.reduce((sum,row)=>sum===null||!row?null:addDecimal(sum,row.quoteQty),'0');
 if(compareDecimal(quote,order.cummulativeQuoteQty)!==0)return null;
 const rows=order.fills.map(fill=>{
  const trade=trades.find(row=>row&&String(row.id)===String(fill.tradeId)&&String(row.orderId)===String(order.orderId));
  if(!trade||trade.symbol!==executionAuthorization.symbol||trade.isBuyer!==true)return null;
  if(compareDecimal(trade.price,fill.price)!==0||compareDecimal(trade.qty,fill.qty)!==0)return null;
  if(compareDecimal(trade.commission,fill.commission)!==0||trade.commissionAsset!==fill.commissionAsset)return null;
  return {tradeId:trade.id,price:trade.price,qty:trade.qty,quoteQty:trade.quoteQty,commission:trade.commission,commissionAsset:trade.commissionAsset};
 });
 if(rows.some(row=>!row))return null;
 return {requestId:REQUEST_ID,orderId:order.orderId,symbol:order.symbol,side:'BUY',quoteOrderQty:executionAuthorization.maxNotional,status:'FILLED',executedQty:order.executedQty,cummulativeQuoteQty:order.cummulativeQuoteQty,fills:rows,reconciled:true};
}
async function readReceipt(receiptPath){
 try{return JSON.parse(await readFile(receiptPath,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function writeReceipt(receiptPath,receipt,{exclusive=false}={}){
 const dir=path.dirname(receiptPath);
 await mkdir(dir,{recursive:true,mode:0o700});
 const target=exclusive?receiptPath:receiptPath+'.tmp';
 let handle;
 try{handle=await open(target,exclusive?'wx':'w',0o600);}
 catch(error){if(exclusive&&error.code==='EEXIST')return false;throw error;}
 try{await handle.writeFile(JSON.stringify(receipt),'utf8');await handle.sync();}finally{await handle.close();}
 await chmod(target,0o600);
 if(!exclusive)await rename(target,receiptPath);
 return true;
}
function stored(receipt){
 return {schema:'spot-order-receipt-v1',requestId:REQUEST_ID,orderId:receipt.orderId??null,symbol:executionAuthorization.symbol,side:'BUY',quoteOrderQty:executionAuthorization.maxNotional,status:receipt.status,executedQty:receipt.executedQty??null,cummulativeQuoteQty:receipt.cummulativeQuoteQty??null,fills:receipt.fills||[],reconciled:receipt.reconciled===true,executionAuthority:'NONE',withdraw:false};
}
export async function runAuthorizedSpotOrder({creds,fetchImpl,now=Date.now(),receiptPath,confirm}={}){
 if(confirm!=='once')fail('CONFIRM_REQUIRED');
 if(!creds||typeof creds.key!=='string'||typeof creds.secret!=='string'||creds.key.length<8||creds.secret.length<8)fail('CREDENTIALS_MISSING');
 if(!mandateMatches(intent(),now)||executionAuthorization.ordersEnabled!==false)fail('OUTSIDE_MANDATE');
 const existing=await readReceipt(receiptPath);
 if(existing?.status==='submitting'){
  try{
   const placed=await signed('GET','/api/v3/order',{symbol:executionAuthorization.symbol,origClientOrderId:REQUEST_ID},creds,fetchImpl);
   const trades=await signed('GET','/api/v3/myTrades',{symbol:executionAuthorization.symbol,orderId:String(placed.orderId)},creds,fetchImpl);
   const matched=reconcileFill(placed,trades);
   const receipt=stored(matched||{status:placed.status||'unreconciled',orderId:placed.orderId,executedQty:placed.executedQty,cummulativeQuoteQty:placed.cummulativeQuoteQty,reconciled:false});
   await writeReceipt(receiptPath,receipt);
   return receipt;
  }catch(error){if(error.exchangeCode!==-2013)throw error;}
  return stored(existing);
 }
 if(existing)return stored(existing);
 const info=await readBody(await fetchImpl(HOST+'/api/v3/exchangeInfo?symbol='+executionAuthorization.symbol,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)}));
 const symbol=info.symbols?.find(row=>row.symbol===executionAuthorization.symbol);
 const notional=symbol?.filters?.find(row=>row.filterType==='NOTIONAL');
 if(!symbol||symbol.status!=='TRADING'||!notional||compareDecimal(notional.minNotional,executionAuthorization.maxNotional)===1)fail('EXCHANGE_MINIMUM');
 const account=await signed('GET','/api/v3/account',{},creds,fetchImpl);
 const restrictions=await signed('GET','/sapi/v1/account/apiRestrictions',{},creds,fetchImpl);
 const usdt=account.balances?.find(row=>row.asset==='USDT');
 if(withdrawOn(restrictions)||account.canTrade!==true&&restrictions.enableSpotAndMarginTrading!==true)fail('WITHDRAW_OR_TRADE');
 if(!usdt||compareDecimal(usdt.free,executionAuthorization.maxNotional)===-1)fail('BALANCE');
 await signed('POST','/api/v3/order/test',orderParams(),creds,fetchImpl);
 const pending=stored({status:'submitting',reconciled:false});
 if(!await writeReceipt(receiptPath,pending,{exclusive:true}))return stored(await readReceipt(receiptPath));
 let placed;
 try{placed=await signed('POST','/api/v3/order',orderParams(),creds,fetchImpl);}
 catch(error){
  if(Number.isInteger(error.exchangeCode)){
   await writeReceipt(receiptPath,stored({status:'failed',reconciled:false}));
   throw error;
  }
  try{
   placed=await signed('GET','/api/v3/order',{symbol:executionAuthorization.symbol,origClientOrderId:REQUEST_ID},creds,fetchImpl);
  }catch(lookup){
   if(lookup.exchangeCode===-2013)await writeReceipt(receiptPath,stored({status:'failed',reconciled:false}));
   throw error;
  }
 }
 let trades=[];
 try{trades=await signed('GET','/api/v3/myTrades',{symbol:executionAuthorization.symbol,orderId:String(placed.orderId)},creds,fetchImpl);}catch{trades=[];}
 const matched=reconcileFill(placed,trades);
 const receipt=stored(matched||{status:placed.status||'unreconciled',orderId:placed.orderId,executedQty:placed.executedQty,cummulativeQuoteQty:placed.cummulativeQuoteQty,fills:[],reconciled:false});
 await writeReceipt(receiptPath,receipt);
 return receipt;
}

function mainArguments(argv){return argv.includes('--confirm-once')?'once':'';}
if(process.argv[1]&&import.meta.url.endsWith(process.argv[1].replaceAll('\\','/'))){
 const {homedir}=await import('node:os');
 runAuthorizedSpotOrder({creds:{key:process.env.BINANCE_API_KEY||'',secret:process.env.BINANCE_API_SECRET||''},fetchImpl:globalThis.fetch,receiptPath:process.env.ASTARTER_SPOT_RECEIPT||path.join(homedir(),'.config/astarter/spot-order-receipt.json'),confirm:mainArguments(process.argv)}).then(receipt=>{process.stdout.write(JSON.stringify(receipt)+'\n');},error=>{process.stdout.write(JSON.stringify({ok:false,error:error.code||'ORDER_FAILED',exchangeCode:Number.isInteger(error.exchangeCode)?error.exchangeCode:undefined,executionAuthority:'NONE'})+'\n');process.exitCode=1;});
}
