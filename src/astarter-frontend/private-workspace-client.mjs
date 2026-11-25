import {validatePrivateWorkspaceState,validatePrivateNotificationStateV2,validatePrivateUICommandResult,validatePrivateUIWorkspaceInput,validatePrivateUINotificationCommand} from './private-ui-data.mjs';

const MAX_BYTES=65536;
const REQUEST=/^[A-Za-z0-9:_-]{8,96}$/,OWNER=/^[A-Za-z0-9:_@.\-]{1,256}$/;
const copy=value=>structuredClone(value);
function same(a,b){
 if(a===b)return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const keys=Object.keys(a),other=Object.keys(b);
 return keys.length===other.length&&keys.every(key=>Object.hasOwn(b,key)&&same(a[key],b[key]));
}
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=code=>{throw Error(code);};
const projection=value=>({preferences:value.preferences,drafts:value.drafts,selectedDraftId:value.selectedDraftId});
const notificationCanonical=value=>{const {reminderUnreadCount,...original}=value;return {...original,schema:'private-notifications-v1'};};
function canonicalInput(value,requestId='workspace-input-validation',baseRevision=0,domain='workspace'){
 if(domain==='notifications'){
  if(!exact(value,['action','payload']))fail('PRIVATE_REQUEST_INVALID');
  const command=validatePrivateUINotificationCommand({requestId,baseRevision,...value});return {action:command.action,payload:command.payload};
 }
 if(!exact(value,['preferences','drafts','selectedDraftId']))fail('PRIVATE_REQUEST_INVALID');
 return projection(validatePrivateUIWorkspaceInput({requestId,baseRevision,...value}));
}
function matchesInput(state,input,domain){
 if(domain==='workspace')return same(projection(state),input);
 if(input.action==='save')return state.inapp===input.payload.inapp&&same(state.events,input.payload.events)&&['telegram','email'].every(channel=>state.channels[channel].enabled===0);
 // The applied receipt binds this command ID and base revision. Never invent read rows locally.
 return state.inbox.filter(row=>input.payload.ids.includes(row.id)).every(row=>row.readAt!==null);
}

async function readJSON(response,bounded){
 if(response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')||'')||!response.body?.getReader)fail('PRIVATE_UI_PROTOCOL');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),parts=[];let bytes=0,complete=false;
 try{
  for(;;){
   const chunk=await bounded(reader.read());if(chunk.done){complete=true;break;}
   if(!(chunk.value instanceof Uint8Array))fail('PRIVATE_UI_PROTOCOL');
   bytes+=chunk.value.byteLength;if(bytes>MAX_BYTES)fail('PRIVATE_UI_PROTOCOL');parts.push(decoder.decode(chunk.value,{stream:true}));
  }
  parts.push(decoder.decode());return JSON.parse(parts.join(''));
 }finally{
  if(!complete)try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}
  try{reader.releaseLock();}catch{}
 }
}

// ownerRef partitions tab-local recovery only. Every HTTP request is authenticated by the server cookie.
function createPrivateAccountClient({fetchImpl=globalThis.fetch,storage,now=Date.now,onChange=()=>{},timeoutMs=15000,makeRequestId=()=>globalThis.crypto.randomUUID()}={},domain){
 const prefix='/api/'+domain,storagePrefix='astarter.private-'+domain+'.v1:',validateState=domain==='workspace'?validatePrivateWorkspaceState:validatePrivateNotificationStateV2;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail('PRIVATE_TIMEOUT_INVALID');
 if(storage===undefined)try{storage=globalThis.sessionStorage;}catch{storage=null;}
 let identity=null,active=true,disposed=false,epoch=0,controller=null,inFlight=null;
 let status='auth-required',state=null,localInput=null,intent=null,lastRequestId=null,error=null,invalidCache=false,requiresLoad=true,blocked=false;
 const key=()=>storagePrefix+encodeURIComponent(identity.ownerRef);
 const validIdentity=()=>Boolean(identity&&integer(now())&&identity.expiresAt>now());
 function abort(){epoch++;controller?.abort();controller=null;inFlight=null;}
 function expire(){
  if(identity&&!validIdentity()&&!blocked){abort();state=null;blocked=true;requiresLoad=true;status='auth-required';error='PRIVATE_AUTH_REQUIRED';}
 }
 function snapshot(){
  expire();const authorized=active&&!disposed&&validIdentity()&&!blocked;
  return copy({status,ownerRef:identity?.ownerRef||null,expiresAt:identity?.expiresAt||null,state:authorized?state:null,localInput:authorized?localInput:null,requestId:intent?.requestId||null,error,
   canLoad:active&&!disposed&&validIdentity()&&!blocked&&!inFlight,
   canSave:authorized&&!inFlight&&!invalidCache&&!requiresLoad&&Boolean(state)&&!intent,
   canQuery:active&&!disposed&&validIdentity()&&!blocked&&!inFlight&&Boolean(intent),executionAuthority:'NONE'});
 }
 const emit=()=>onChange(snapshot());
 function persist(){
  try{
   if(!storage?.setItem)throw Error();
   const text=JSON.stringify({version:1,ownerRef:identity.ownerRef,localInput,intent,lastRequestId});
   if(new TextEncoder().encode(text).byteLength>MAX_BYTES)throw Error();
   storage.setItem(key(),text);return true;
  }catch{return false;}
 }
 function restore(){
  state=null;localInput=null;intent=null;lastRequestId=null;invalidCache=false;requiresLoad=true;blocked=false;error=null;status=identity?'idle':'auth-required';
  if(!identity)return;
  try{
   const text=storage?.getItem?.(key());if(text===null||text===undefined)return;
   if(typeof text!=='string'||new TextEncoder().encode(text).byteLength>MAX_BYTES)throw Error();
   const saved=JSON.parse(text);
   if(!exact(saved,['version','ownerRef','localInput','intent','lastRequestId'])||saved.version!==1||saved.ownerRef!==identity.ownerRef||saved.lastRequestId!==null&&(typeof saved.lastRequestId!=='string'||!REQUEST.test(saved.lastRequestId)))throw Error();
   const value=saved.localInput===null?null:canonicalInput(saved.localInput,undefined,0,domain);
   if(saved.intent!==null&&(!exact(saved.intent,['requestId','baseRevision','createdAt'])||typeof saved.intent.requestId!=='string'||!REQUEST.test(saved.intent.requestId)||saved.intent.requestId!==saved.lastRequestId||!integer(saved.intent.baseRevision)||!integer(saved.intent.createdAt)||saved.intent.createdAt>now()||!value))throw Error();
   localInput=value;intent=copy(saved.intent);lastRequestId=saved.lastRequestId;if(intent){status='unknown';error='PRIVATE_REQUEST_UNCONFIRMED';}
  }catch{invalidCache=true;status='error';error='PRIVATE_LOCAL_STATE_INVALID';}
 }
 function mergeState(value,authoritative=false){
  if(state&&value.revision===state.revision){
   if(domain==='workspace'){if(!same(value,state))fail('PRIVATE_UI_PROTOCOL');}
   else{
    if(!same(notificationCanonical(value),notificationCanonical(state))||value.schema==='private-notifications-v2'&&state.schema==='private-notifications-v2'&&value.reminderUnreadCount!==state.reminderUnreadCount)fail('PRIVATE_UI_PROTOCOL');
    // Only the explicitly versioned GET adds a verified reminder count. The
    // immutable v1 receipt cannot discard it or change the same-revision state.
    if(authoritative||state.schema!=='private-notifications-v2')state=value;
   }
  }else if(!state||value.revision>state.revision)state=value;
 }
 async function send(kind){
  expire();if(disposed||!active||!validIdentity()||blocked)return snapshot();
  if(inFlight)return inFlight;if(kind==='query'&&!intent)return snapshot();
  const version=epoch,owner=identity.ownerRef,request=intent&&copy(intent),input=localInput&&copy(localInput),aborter=new AbortController();controller=aborter;
  const current=()=>version===epoch&&identity?.ownerRef===owner&&active&&!disposed&&validIdentity();
  let expired=false,rejectDeadline,responseStatus=0;
  const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});deadline.catch(()=>{});
  const interrupted=()=>rejectDeadline(Error('PRIVATE_REQUEST_ABORTED'));
  aborter.signal.addEventListener('abort',interrupted,{once:true});
  const timer=setTimeout(()=>{expired=true;aborter.abort();},timeoutMs),bounded=promise=>Promise.race([promise,deadline]);
  status=kind==='save'?'saving':'loading';error=null;
  const pending=Promise.resolve().then(async()=>{
   try{
    if(!current()||aborter.signal.aborted)return snapshot();
    const init={method:kind==='save'?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:aborter.signal};
    if(kind==='save'){init.headers['Content-Type']='application/json';init.body=JSON.stringify({requestId:request.requestId,baseRevision:request.baseRevision,...input});}
    const url=kind==='save'?prefix+(domain==='workspace'?'/save':'/command'):kind==='query'?prefix+'/request?requestId='+encodeURIComponent(request.requestId):prefix+'/state'+(domain==='notifications'?'?responseVersion=2':'');
    const exchange=Promise.resolve().then(()=>{if(!current()||aborter.signal.aborted)fail('PRIVATE_REQUEST_ABORTED');return fetchImpl(url,init);});
    void exchange.then(response=>{if(expired||!current())try{Promise.resolve(response?.body?.cancel?.()).catch(()=>{});}catch{}},()=>{});
    const response=await bounded(exchange);responseStatus=response.status;
    const body=await bounded(readJSON(response,bounded));if(!current())return snapshot();
    if(responseStatus===401||responseStatus===403){blocked=true;requiresLoad=true;state=null;status=responseStatus===401?'auth-required':'forbidden';error=responseStatus===401?'PRIVATE_AUTH_REQUIRED':'PRIVATE_FORBIDDEN';}
    else if(kind==='save'&&responseStatus===409&&body?.error==='PRIVATE_CONFLICT'){
     intent=null;requiresLoad=true;status='conflict';error='PRIVATE_CONFLICT';if(!persist())invalidCache=true;
    }else if(responseStatus<200||responseStatus>=300)fail(body?.error==='PRIVATE_COMMIT_UNKNOWN'?'PRIVATE_COMMIT_UNKNOWN':'PRIVATE_SERVICE_UNAVAILABLE');
    else if(kind==='load'){
     const value=validateState(body,owner);if(state&&value.revision<state.revision)fail('PRIVATE_UI_PROTOCOL');mergeState(value,true);requiresLoad=false;status=intent?'unknown':'ready';error=intent?'PRIVATE_REQUEST_UNCONFIRMED':null;
    }else if(body===null&&kind==='query'){
     status='unknown';error='PRIVATE_REQUEST_NOT_FOUND';
    }else{
     const result=validatePrivateUICommandResult(body,domain,request.requestId,owner);
     if(result.request.baseRevision!==request.baseRevision||!matchesInput(result.state,input,domain))fail('PRIVATE_UI_PROTOCOL');
     mergeState(result.state);intent=null;requiresLoad=false;status='ready';error=null;
     if(!persist()){invalidCache=true;error='PRIVATE_STORAGE_UNAVAILABLE';}
    }
   }catch(cause){
    if(!current())return snapshot();
    if(responseStatus===401||responseStatus===403){blocked=true;requiresLoad=true;state=null;status=responseStatus===401?'auth-required':'forbidden';error=responseStatus===401?'PRIVATE_AUTH_REQUIRED':'PRIVATE_FORBIDDEN';}
    else{status=intent?'unknown':'error';error=expired?'PRIVATE_REQUEST_TIMEOUT':['PRIVATE_UI_PROTOCOL','PRIVATE_COMMIT_UNKNOWN'].includes(cause?.code||cause?.message)?cause.code||cause.message:'PRIVATE_REQUEST_UNCONFIRMED';}
   }finally{
    clearTimeout(timer);aborter.signal.removeEventListener('abort',interrupted);
    if(version===epoch&&identity?.ownerRef===owner){controller=null;inFlight=null;emit();}
   }
   return snapshot();
  });
  inFlight=pending;emit();return pending;
 }
 return {
  snapshot,
  setIdentity(value){
   if(disposed)return snapshot();
   const next=exact(value,['ownerRef','expiresAt'])&&typeof value.ownerRef==='string'&&OWNER.test(value.ownerRef)&&integer(value.expiresAt)&&value.expiresAt>now()?{ownerRef:value.ownerRef,expiresAt:value.expiresAt}:null;
   if(active&&!blocked&&same(next,identity))return snapshot();
   abort();identity=next;active=true;restore();expire();emit();return snapshot();
  },
  load(){return send('load');},
  async save(value){
   expire();if(disposed||!active||!validIdentity()||blocked)return snapshot();
   if(intent)fail('PRIVATE_ORIGINAL_REQUEST_PENDING');
   if(inFlight||invalidCache||requiresLoad||!state)fail('PRIVATE_WORKSPACE_NOT_READY');
   const canonical=canonicalInput(value,undefined,0,domain),requestId=makeRequestId(),createdAt=now();
   if(typeof requestId!=='string'||!REQUEST.test(requestId)||requestId===lastRequestId||!integer(createdAt))fail('PRIVATE_REQUEST_INVALID');
   localInput=canonicalInput(canonical,requestId,state.revision,domain);intent={requestId,baseRevision:state.revision,createdAt};lastRequestId=requestId;
   if(!persist()){intent=null;invalidCache=true;status='error';error='PRIVATE_STORAGE_UNAVAILABLE';emit();return snapshot();}
   return send('save');
  },
  queryOriginal(){return send('query');},
  leave(){if(disposed)return snapshot();abort();active=false;state=null;requiresLoad=true;status='idle';error=null;emit();return snapshot();},
  dispose(){if(disposed)return;abort();active=false;disposed=true;state=null;localInput=null;status='idle';error=null;}
 };
}

export const createPrivateWorkspaceClient=options=>createPrivateAccountClient(options,'workspace');
export const createPrivateNotificationsClient=options=>createPrivateAccountClient(options,'notifications');
