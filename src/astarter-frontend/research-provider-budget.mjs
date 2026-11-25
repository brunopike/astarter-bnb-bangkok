import {Buffer} from 'node:buffer';
import {researchCostMicrousd} from './research-analysis-service.mjs';

const ENDPOINT='https://openrouter.ai/api/v1/key',MAX_BYTES=16384,MAX_BUDGET=50000000;
const INTERNAL=Symbol('provider-budget-error');
const fault=code=>Object.assign(Error(code),{code,[INTERNAL]:true});
const plain=value=>value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype;
const nonnegative=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

// Separate provider hard-limit proof. The private monthly ledger remains an
// independent admission requirement. Construction performs no I/O or key mutation.
export function createResearchProviderBudget({apiKey='',fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=5000,maxMicrousd=MAX_BUDGET}={}){
 const configured=typeof apiKey==='string'&&apiKey.length>=16&&apiKey.length<=512&&!/[\s\u0000-\u001f\u007f]/.test(apiKey)&&typeof fetchImpl==='function'&&typeof now==='function'&&Number.isSafeInteger(timeoutMs)&&timeoutMs>=10&&timeoutMs<=8000&&Number.isSafeInteger(maxMicrousd)&&maxMicrousd>0&&maxMicrousd<=MAX_BUDGET;
 return {configured,async verify(){
  if(!configured)throw fault('PROVIDER_BUDGET_UNCONFIGURED');
  const controller=new AbortController();let timer,reader,complete=false;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fault('PROVIDER_BUDGET_TIMEOUT'));},timeoutMs);});
  const bounded=promise=>Promise.race([promise,deadline]);
  try{
   const response=await bounded(fetchImpl(ENDPOINT,{method:'GET',headers:{Accept:'application/json',Authorization:'Bearer '+apiKey},credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal}));
   if(!response?.ok||response.redirected||response.url&&new URL(response.url).href!==ENDPOINT)throw fault('PROVIDER_BUDGET_UNAVAILABLE');
   const length=response.headers?.get?.('content-length');
   if(length!==undefined&&length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))throw fault('PROVIDER_BUDGET_INVALID');
   if(response.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||typeof response.body?.getReader!=='function')throw fault('PROVIDER_BUDGET_INVALID');
   reader=response.body.getReader();const parts=[];let bytes=0;
   for(let chunks=0;;chunks++){
    if(chunks>1024)throw fault('PROVIDER_BUDGET_INVALID');
    const {done,value}=await bounded(reader.read());if(done){complete=true;break;}
    if(!(value instanceof Uint8Array))throw fault('PROVIDER_BUDGET_INVALID');
    bytes+=value.byteLength;if(bytes>MAX_BYTES)throw fault('PROVIDER_BUDGET_INVALID');parts.push(Buffer.from(value));
   }
   let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw fault('PROVIDER_BUDGET_INVALID');}
   const data=body?.data;
   if(!plain(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'data')||!plain(data)||data.is_management_key!==false||!nonnegative(data.limit)||data.limit<=0||!nonnegative(data.limit_remaining)||data.limit_remaining>data.limit||!nonnegative(data.usage_monthly)||data.limit_reset!=='monthly'&&data.limit_reset!==null)throw fault('PROVIDER_BUDGET_INVALID');
   const limitMicrousd=researchCostMicrousd(data.limit),remainingMicrousd=researchCostMicrousd(data.limit_remaining);
   if(limitMicrousd===null||remainingMicrousd===null||limitMicrousd<=0||remainingMicrousd>limitMicrousd)throw fault('PROVIDER_BUDGET_INVALID');
   if(limitMicrousd>maxMicrousd)throw fault('PROVIDER_BUDGET_EXCEEDED');
   const checkedAt=now();if(!Number.isSafeInteger(checkedAt)||checkedAt<0)throw fault('PROVIDER_BUDGET_INVALID');
   return {checkedAt,limitMicrousd,remainingMicrousd,reset:data.limit_reset};
  }catch(error){throw error?.[INTERNAL]?error:fault(controller.signal.aborted?'PROVIDER_BUDGET_TIMEOUT':'PROVIDER_BUDGET_UNAVAILABLE');}
  finally{clearTimeout(timer);controller.abort();if(reader){if(!complete)try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}try{reader.releaseLock?.();}catch{}}}
 }};
}
