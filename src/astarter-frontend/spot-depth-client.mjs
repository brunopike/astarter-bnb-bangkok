import {validateSpotDepthSnapshot} from './spot-depth-data.mjs';

export function subscribeSpotDepth(symbol,{onSnapshot=()=>{},onStatus=()=>{}}={},
 {fetchImpl=globalThis.fetch,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 if(!['BTC','ETH','SOL'].includes(symbol)){onStatus({state:'unsupported'});return ()=>{};}
 let stopped=false,pending=null,timer=null,deadline=null,failures=0;
 async function load(){
  if(stopped||pending)return;
  const controller=new AbortController();pending=controller;
  const timeout=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(Error('DEPTH_TIMEOUT')),{once:true});deadline=setTimer(()=>controller.abort(),8000);});let delay=15000;
  try{
   const response=await Promise.race([fetchImpl('/api/market-hub?'+new URLSearchParams({resource:'spot-depth',symbol}),{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal}),timeout]);
   if(!response.ok){try{void response.body?.cancel().catch(()=>{});}catch{}delay=Math.min(300000,Math.max(delay,Number(response.headers?.get?.('Retry-After'))*1000||0));throw Error('DEPTH_UNAVAILABLE');}
   const body=await Promise.race([response.json(),timeout]);if(stopped||pending!==controller)return;
   if(controller.signal.aborted)throw Error('DEPTH_TIMEOUT');
   if(body?.schema!=='public-market-relay-v1'||body.resource!=='spot-depth'||body.receivedAt!==body.body?.receivedAt)throw Error('INVALID_SPOT_DEPTH');
   const snapshot=validateSpotDepthSnapshot(body.body,symbol,now());
   failures=0;onSnapshot(snapshot);if(!stopped&&pending===controller&&!controller.signal.aborted)onStatus({state:'ready'});
  }catch{
   if(!stopped&&pending===controller){onStatus({state:'error'});delay=Math.max(delay,Math.min(120000,15000*2**Math.min(3,failures++)));}
  }finally{
   clearTimer(deadline);deadline=null;if(pending===controller)pending=null;
   if(!stopped)timer=setTimer(load,delay);
  }
 }
 onStatus({state:'loading'});load();
 return ()=>{if(stopped)return;stopped=true;pending?.abort();pending=null;clearTimer(timer);clearTimer(deadline);};
}
