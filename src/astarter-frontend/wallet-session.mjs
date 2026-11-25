export async function walletRequest(path,body){
 const response=await fetch('/api/wallet/'+path,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(path==='verify'?35000:['nonce','message'].includes(path)?15000:10000),...(body!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 const unavailable=()=>Object.assign(Error('wallet-service-unavailable'),{status:response.status>=500?response.status:503});
 let data;try{data=await response.json();}catch{throw unavailable();}
 if(!data||typeof data!=='object'||Array.isArray(data))throw unavailable();
 if(!response.ok){if(typeof data.error!=='string'||!/^[a-z][a-z0-9-]{0,95}$/.test(data.error))throw unavailable();throw Object.assign(Error(data.error),{status:response.status});}
 if(path==='nonce'&&(typeof data.nonce!=='string'||!data.nonce)||path==='message'&&(typeof data.message!=='string'||!data.message))throw unavailable();
 if(['session','verify','logout'].includes(path)&&(!Object.hasOwn(data,'session')||data.session!==null&&(!data.session||typeof data.session!=='object'||typeof data.session.address!=='string'||!/^0x[0-9a-f]{40}$/i.test(data.session.address)||data.session.chain!==56||!Number.isFinite(data.session.expires)||data.session.expires<=0)||path==='verify'&&data.session===null))throw unavailable();
 return data;
}

const REFERRAL_KEY='astarter.wallet.referral.v1';
export function captureWalletReferral({storage,search=globalThis.location?.search||''}={}){
 if(storage===undefined)try{storage=globalThis.sessionStorage;}catch{}
 const code=new URLSearchParams(search).get('ref');
 if(typeof code==='string'&&/^[A-Za-z0-9_-]{32}$/.test(code)){try{storage?.setItem(REFERRAL_KEY,code);}catch{}return code;}
 let saved;try{saved=storage?.getItem(REFERRAL_KEY);}catch{}
 return typeof saved==='string'&&/^[A-Za-z0-9_-]{32}$/.test(saved)?saved:null;
}

export function createWalletSession({request=walletRequest,update,storage,referralStorage,referralSearch}){
 let state={session:undefined,error:null,busy:false},version=0,flowEpoch=0,prepared=null,logoutRequest,logoutPending=false,revalidation;
 let tabStorage=referralStorage;if(tabStorage===undefined)try{tabStorage=globalThis.sessionStorage;}catch{}
 let referralCode=captureWalletReferral({storage:tabStorage,search:referralSearch});
 try{logoutPending=storage?.getItem('astarter.wallet.logout')==='pending';}catch{}
 const publish=patch=>{state={...state,...patch};update(state);};
 const remember=value=>{logoutPending=value;try{if(value)storage?.setItem('astarter.wallet.logout','pending');else storage?.removeItem('astarter.wallet.logout');}catch{}};
 const authError=error=>error?.status>=500||error?.name==='TimeoutError'||error?.name==='AbortError'||error instanceof TypeError?'service':'verify';
 const cancelFlow=()=>{flowEpoch++;prepared=null;};
 const checkFlow=epoch=>{if(epoch!==flowEpoch)throw Error('authentication-cancelled');};
 async function signOut(){
  if(logoutRequest)return logoutRequest;
  ++version;cancelFlow();remember(true);publish({session:null,error:null,busy:'logout'});
  logoutRequest=request('logout',{}).then(()=>{remember(false);publish({busy:false});return true;},()=>{publish({error:'logout',busy:false});return false;}).finally(()=>{logoutRequest=undefined;});
  return logoutRequest;
 }
 async function ready(){
  if(logoutRequest)await logoutRequest;
  try{if(storage?.getItem('astarter.wallet.logout')==='pending')logoutPending=true;}catch{}
  if(logoutPending||state.error==='logout'){
   if(!await signOut())throw Error('logout-pending');
  }
 }
 async function refresh(){
  try{await ready();}catch{return false;}
  const current=++version;publish({busy:'session',error:null});
  try{
   const result=await request('session');
   if(current!==version)return false;
   publish({session:result.session,error:null,busy:false});return true;
  }catch{
   if(current===version)publish({session:null,error:'service',busy:false});
   return false;
  }
 }
 const adapter={
  getNonce:async()=>{await ready();cancelFlow();const epoch=flowEpoch;publish({error:null});try{const result=await request('nonce',{});checkFlow(epoch);return result.nonce;}catch(error){if(epoch===flowEpoch)publish({error:authError(error)});throw error;}},
  createMessage:async({nonce,address,chainId})=>{
   const before=flowEpoch;await ready();checkFlow(before);cancelFlow();const epoch=flowEpoch;
   const prepare=message=>{checkFlow(epoch);if(typeof message!=='string'||!message)throw Object.assign(Error('wallet-service-unavailable'),{status:503});prepared={message,epoch};return message;};
   try{return prepare((await request('message',{nonce,address,chainId})).message);}
   catch(error){
    checkFlow(epoch);if(error.message!=='challenge-expired'){publish({error:authError(error)});throw error;}
    // RainbowKit keeps its nonce after a rejected or failed attempt; renew an expired/consumed challenge.
    try{const fresh=await request('nonce',{});checkFlow(epoch);return prepare((await request('message',{nonce:fresh.nonce,address,chainId})).message);}
    catch(retryError){if(epoch===flowEpoch)publish({error:authError(retryError)});throw retryError;}
   }
  },
  verify:async({message,signature})=>{
   const flow=prepared;
   if(!flow||flow.message!==message||flow.epoch!==flowEpoch)return false;
   try{await ready();}catch{return false;}
   if(prepared!==flow||flow.epoch!==flowEpoch||logoutPending||logoutRequest)return false;
   prepared=null;
   const current=++version;
   publish({busy:'verify',error:null});
   try{
    const result=await request('verify',{message,signature,...(referralCode?{referralCode}:{})});
    if(current!==version||flow.epoch!==flowEpoch){await signOut();return false;}
    if(result.session&&['accepted','already-linked','invalid','self'].includes(result.referralApplied)){referralCode=null;try{tabStorage?.removeItem(REFERRAL_KEY);}catch{}}
    publish({session:result.session,error:null,busy:false});return true;
   }catch(error){
    if(current===version)publish({session:null,error:authError(error),busy:false});
    return false;
   }
  },
  signOut
 };
 const expire=()=>{++version;cancelFlow();publish({session:null,busy:logoutRequest?'logout':false});};
 function reauthenticate(){
  if(revalidation)return revalidation;
  expire();
  const epoch=flowEpoch;
  revalidation=refresh().then(ok=>ok&&epoch===flowEpoch?{session:state.session}:null).finally(()=>{revalidation=undefined;});
  return revalidation;
 }
 return {adapter,refresh,expire,reauthenticate};
}
