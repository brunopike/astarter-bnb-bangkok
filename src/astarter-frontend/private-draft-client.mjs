import {validatePrivateDraftPreviewInput,validatePrivateDraftAdoptInput,validatePrivateDraftDocument,validatePrivateDraftPreview,validatePrivateDraftCommandResult} from './private-draft-data.mjs';

const PREFIX='/api/strategy-drafts',STORAGE='astarter.private-drafts.v1:',MAX_BYTES=65536;
const REQUEST=/^[A-Za-z0-9:_-]{8,96}$/,OWNER=/^[A-Za-z0-9:_-]{1,128}$/;
const integer=value=>Number.isSafeInteger(value)&&value>=0,copy=value=>structuredClone(value);
const fail=code=>{throw Error(code);};
const exact=(value,keys)=>value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function same(a,b){
 if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&same(a[key],b[key]));
}
const inputOf=preview=>({draftId:preview.draftId,sourceRequestId:preview.proposal.source.sourceRequestId,fields:copy(preview.proposal.fields)});
function matchesPreview(preview,input){return preview.draftId===input.draftId&&preview.proposal.source.sourceRequestId===input.sourceRequestId&&same(preview.proposal.fields,input.fields);}
function matchesIntent(preview,input){return matchesPreview(preview,input)&&preview.expectedRevision===input.expectedRevision&&preview.workspaceRevision===input.workspaceRevision&&preview.proposalRevision===input.proposalRevision;}
async function readJSON(response,bounded){
 if(response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')||'')||!response.body?.getReader)fail('PRIVATE_UI_PROTOCOL');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),parts=[];let bytes=0,complete=false;
 try{
  for(;;){const next=await bounded(reader.read());if(next.done){complete=true;break;}if(!(next.value instanceof Uint8Array))fail('PRIVATE_UI_PROTOCOL');bytes+=next.value.byteLength;if(bytes>MAX_BYTES)fail('PRIVATE_UI_PROTOCOL');parts.push(decoder.decode(next.value,{stream:true}));}
  parts.push(decoder.decode());return JSON.parse(parts.join(''));
 }finally{if(!complete)try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
}
function knownError(body){
 return body&&body.executionAuthority==='NONE'&&typeof body.error==='string'&&['AUTH_REQUIRED','PRIVATE_AUTH_REQUIRED','PRIVATE_FORBIDDEN','PRIVATE_TARGET_MISMATCH','PRIVATE_REQUEST_INVALID','PRIVATE_CONFLICT','PRIVATE_UNAVAILABLE','PRIVATE_UNCONFIGURED','PRIVATE_UI_PROTOCOL','PRIVATE_COMMIT_UNKNOWN','ORIGIN_DENIED','METHOD_NOT_ALLOWED','BODY_TOO_LARGE','JSON_REQUIRED'].includes(body.error)&&Object.keys(body).every(key=>['error','executionAuthority','requestId','queryOriginalRequest'].includes(key))&&(!Object.hasOwn(body,'requestId')||typeof body.requestId==='string'&&REQUEST.test(body.requestId))&&(!Object.hasOwn(body,'queryOriginalRequest')||typeof body.queryOriginalRequest==='boolean');
}

// ownerRef partitions recovery metadata only. The same-origin server cookie owns authentication and draft authority.
export function createPrivateDraftClient({storage,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=15000,makeRequestId=()=>globalThis.crypto.randomUUID(),onChange=()=>{}}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)fail('PRIVATE_TIMEOUT_INVALID');
 if(storage===undefined)try{storage=globalThis.sessionStorage;}catch{storage=null;}
 let identity=null,disposed=false,epoch=0,controller=null,inFlight=null,operation=null,expiryTimer=null,blocked=false,invalidCache=false;
 let status='auth-required',error=null,draft=null,verifiedPreview=null,localInput=null,intent=null,lastRequestId=null;
 const key=()=>STORAGE+encodeURIComponent(identity.ownerRef);
 const validIdentity=()=>Boolean(identity&&integer(now())&&identity.expiresAt>now());
 function abort(){epoch++;controller?.abort();controller=null;inFlight=null;operation=null;}
 function expire(){
  if(identity&&!validIdentity()&&!blocked){abort();clearTimeout(expiryTimer);expiryTimer=null;blocked=true;draft=null;verifiedPreview=null;localInput=null;status='auth-required';error='PRIVATE_AUTH_REQUIRED';}
  if(verifiedPreview&&verifiedPreview.proposal.source.validUntil<=now()){
   verifiedPreview=null;if(!intent&&!inFlight){status=draft?'ready':'idle';error='PRIVATE_DRAFT_PREVIEW_EXPIRED';}
  }
 }
 function snapshot(){
  expire();const authorized=!disposed&&validIdentity()&&!blocked;
  return copy({status,ownerRef:identity?.ownerRef||null,expiresAt:identity?.expiresAt||null,draft:authorized?draft:null,preview:authorized?verifiedPreview:null,localInput:authorized?localInput:null,requestId:intent?.input.requestId||null,error,
   canGet:authorized&&!inFlight&&!intent,canPreview:authorized&&!inFlight&&!intent&&!invalidCache,
   canAdopt:authorized&&!inFlight&&!intent&&!invalidCache&&Boolean(verifiedPreview)&&verifiedPreview.proposal.source.createdAt<=now()&&now()<verifiedPreview.proposal.source.validUntil,
   canQuery:authorized&&!inFlight&&Boolean(intent),executionAuthority:'NONE'});
 }
 const emit=()=>{if(!disposed)onChange(snapshot());};
 function armExpiry(){
  clearTimeout(expiryTimer);expiryTimer=null;if(disposed||blocked||!validIdentity())return;
  const version=epoch,owner=identity.ownerRef,at=Math.min(identity.expiresAt,verifiedPreview?.proposal.source.validUntil??identity.expiresAt);
  expiryTimer=setTimeout(()=>{if(disposed||epoch!==version||identity?.ownerRef!==owner)return;expire();emit();armExpiry();},Math.max(1,Math.min(at-now(),2147483647)));expiryTimer?.unref?.();
 }
 function persist(){
  try{
   if(!storage?.setItem||!storage?.getItem)throw Error();
   const value=JSON.stringify({version:1,ownerRef:identity.ownerRef,intent,lastRequestId});if(new TextEncoder().encode(value).byteLength>MAX_BYTES)throw Error();
   storage.setItem(key(),value);if(storage.getItem(key())!==value)throw Error();return true;
  }catch{return false;}
 }
 function restore(){
  draft=null;verifiedPreview=null;localInput=null;intent=null;lastRequestId=null;blocked=false;invalidCache=false;status=identity?'idle':'auth-required';error=null;
  if(!identity)return;
  try{
   const raw=storage?.getItem?.(key());if(raw===null||raw===undefined)return;
   if(typeof raw!=='string'||new TextEncoder().encode(raw).byteLength>MAX_BYTES)throw Error();const saved=JSON.parse(raw);
   if(!exact(saved,['version','ownerRef','intent','lastRequestId'])||saved.version!==1||saved.ownerRef!==identity.ownerRef||saved.lastRequestId!==null&&(typeof saved.lastRequestId!=='string'||!REQUEST.test(saved.lastRequestId)))throw Error();
   lastRequestId=saved.lastRequestId;
   if(saved.intent!==null){
    if(!exact(saved.intent,['input','preview','createdAt'])||!integer(saved.intent.createdAt)||saved.intent.createdAt>now())throw Error();
    const input=validatePrivateDraftAdoptInput(saved.intent.input),preview=validatePrivateDraftPreview(saved.intent.preview,identity.ownerRef);
    if(input.requestId!==lastRequestId||!matchesIntent(preview,input))throw Error();
    intent={input,preview,createdAt:saved.intent.createdAt};localInput=inputOf(preview);status='unknown';error='PRIVATE_REQUEST_UNCONFIRMED';
   }
  }catch{invalidCache=true;status='error';error='PRIVATE_LOCAL_STATE_INVALID';}
 }
 async function send(kind,input){
  expire();if(disposed||!validIdentity()||blocked)return snapshot();
  const version=epoch,owner=identity.ownerRef,request=intent&&copy(intent),aborter=new AbortController();controller=aborter;operation=kind;
  const current=()=>!disposed&&epoch===version&&identity?.ownerRef===owner&&validIdentity()&&!blocked;
  let timedOut=false,responseStatus=0,rejectDeadline;
  const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});deadline.catch(()=>{});
  const interrupted=()=>rejectDeadline(Error('PRIVATE_REQUEST_ABORTED'));aborter.signal.addEventListener('abort',interrupted,{once:true});
  const timer=setTimeout(()=>{timedOut=true;aborter.abort();},timeoutMs),bounded=promise=>Promise.race([promise,deadline]);
  status=kind==='adopt'?'adopting':kind==='preview'?'previewing':'loading';error=null;
  const pending=Promise.resolve().then(async()=>{
   try{
    if(!current()||aborter.signal.aborted)return snapshot();
    const post=kind==='adopt'||kind==='preview',init={method:post?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:aborter.signal};
    if(post){init.headers['Content-Type']='application/json';init.body=JSON.stringify(kind==='adopt'?request.input:input);}
    const url=PREFIX+(kind==='get'?'/get?draftId='+encodeURIComponent(input):kind==='query'?'/request?requestId='+encodeURIComponent(request.input.requestId):'/'+kind);
    const exchange=Promise.resolve().then(()=>{if(!current()||aborter.signal.aborted)fail('PRIVATE_REQUEST_ABORTED');return fetchImpl(url,init);});
    void exchange.then(response=>{if(timedOut||!current())try{Promise.resolve(response?.body?.cancel?.()).catch(()=>{});}catch{}},()=>{});
    const response=await bounded(exchange);responseStatus=response.status;const body=await bounded(readJSON(response,bounded));if(!current())return snapshot();
    if(responseStatus===401||responseStatus===403){blocked=true;draft=null;verifiedPreview=null;status=responseStatus===401?'auth-required':'forbidden';error=responseStatus===401?'PRIVATE_AUTH_REQUIRED':'PRIVATE_FORBIDDEN';}
    else if(kind==='adopt'&&knownError(body)&&body.queryOriginalRequest!==true&&(!Object.hasOwn(body,'requestId')||body.requestId===request.input.requestId)&&((responseStatus===409&&body.error==='PRIVATE_CONFLICT')||(responseStatus===400&&body.error==='PRIVATE_REQUEST_INVALID'))){
     intent=null;verifiedPreview=null;status=responseStatus===409?'conflict':'error';error=body.error;if(!persist())invalidCache=true;
    }else if(responseStatus<200||responseStatus>=300)fail(knownError(body)&&body.error==='PRIVATE_COMMIT_UNKNOWN'?'PRIVATE_COMMIT_UNKNOWN':'PRIVATE_REQUEST_UNCONFIRMED');
    else if(kind==='get'){
     const value=body===null?null:validatePrivateDraftDocument(body,owner);if(value&&value.draftId!==input)fail('PRIVATE_UI_PROTOCOL');draft=value;status='ready';
    }else if(kind==='preview'){
     const value=validatePrivateDraftPreview(body,owner);if(!matchesPreview(value,input))fail('PRIVATE_UI_PROTOCOL');
     if(value.proposal.source.createdAt>now()||value.proposal.source.validUntil<=now())fail('PRIVATE_DRAFT_PREVIEW_EXPIRED');
     verifiedPreview=value;status='preview';
    }else if(body===null&&kind==='query'){status='unknown';error='PRIVATE_ORIGINAL_REQUEST_NOT_FOUND';}
    else{
     const value=validatePrivateDraftCommandResult(body,request.input.requestId,owner),original=request.input;
     if(value.draft.draftId!==original.draftId||value.request.expectedRevision!==original.expectedRevision||value.request.workspaceBaseRevision!==original.workspaceRevision||!same(value.draft.content.fields,original.fields)||!same(value.draft.content.source,request.preview.proposal.source))fail('PRIVATE_UI_PROTOCOL');
     draft=value.draft;intent=null;verifiedPreview=null;status='ready';error=null;if(!persist()){invalidCache=true;error='PRIVATE_STORAGE_UNAVAILABLE';}
    }
   }catch(cause){
    if(!current())return snapshot();
    if(responseStatus===401||responseStatus===403){blocked=true;draft=null;verifiedPreview=null;status=responseStatus===401?'auth-required':'forbidden';error=responseStatus===401?'PRIVATE_AUTH_REQUIRED':'PRIVATE_FORBIDDEN';}
    else{verifiedPreview=null;status=intent?'unknown':'error';const code=cause?.code||cause?.message;error=timedOut?'PRIVATE_REQUEST_TIMEOUT':['PRIVATE_UI_PROTOCOL','PRIVATE_COMMIT_UNKNOWN','PRIVATE_DRAFT_PREVIEW_EXPIRED'].includes(code)?code:'PRIVATE_REQUEST_UNCONFIRMED';}
   }finally{
    clearTimeout(timer);aborter.signal.removeEventListener('abort',interrupted);
    if(epoch===version&&identity?.ownerRef===owner){controller=null;inFlight=null;operation=null;armExpiry();emit();}
   }
   return snapshot();
  });
  inFlight=pending;emit();return pending;
 }
 return {
  snapshot,
  setIdentity(value){
   if(disposed)return snapshot();const next=exact(value,['ownerRef','expiresAt'])&&typeof value.ownerRef==='string'&&OWNER.test(value.ownerRef)&&integer(value.expiresAt)&&value.expiresAt>now()?{ownerRef:value.ownerRef,expiresAt:value.expiresAt}:null;
   if(!blocked&&same(next,identity))return snapshot();abort();clearTimeout(expiryTimer);identity=next;restore();armExpiry();emit();return snapshot();
  },
  async get(draftId){
   expire();if(disposed||!validIdentity()||blocked)return snapshot();if(intent)fail('PRIVATE_ORIGINAL_REQUEST_PENDING');if(inFlight)fail('PRIVATE_REQUEST_IN_FLIGHT');
   if(typeof draftId!=='string'||!/^[A-Za-z0-9:_-]{1,96}$/.test(draftId)||/^sk-|^0x[0-9a-f]{64}$/i.test(draftId))fail('PRIVATE_REQUEST_INVALID');verifiedPreview=null;localInput=null;return send('get',draftId);
  },
  async preview(value){
   expire();if(disposed||!validIdentity()||blocked)return snapshot();if(intent)fail('PRIVATE_ORIGINAL_REQUEST_PENDING');if(inFlight)fail('PRIVATE_REQUEST_IN_FLIGHT');if(invalidCache)fail('PRIVATE_LOCAL_STATE_INVALID');
   localInput=validatePrivateDraftPreviewInput(value);verifiedPreview=null;return send('preview',copy(localInput));
  },
  async adopt(){
   expire();if(disposed||!validIdentity()||blocked)return snapshot();if(inFlight&&operation==='adopt')return inFlight;if(intent)fail('PRIVATE_ORIGINAL_REQUEST_PENDING');if(inFlight||invalidCache||!verifiedPreview)fail('PRIVATE_DRAFT_NOT_READY');
   const requestId=makeRequestId(),createdAt=now();if(typeof requestId!=='string'||!REQUEST.test(requestId)||requestId===lastRequestId||!integer(createdAt))fail('PRIVATE_REQUEST_INVALID');
   const value=verifiedPreview,input=validatePrivateDraftAdoptInput({...inputOf(value),requestId,expectedRevision:value.expectedRevision,workspaceRevision:value.workspaceRevision,proposalRevision:value.proposalRevision});
   intent={input,preview:copy(value),createdAt};lastRequestId=requestId;
   if(!persist()){intent=null;invalidCache=true;status='error';error='PRIVATE_STORAGE_UNAVAILABLE';emit();return snapshot();}
   verifiedPreview=null;armExpiry();return send('adopt');
  },
  async query(){expire();if(disposed||!validIdentity()||blocked||!intent)return snapshot();if(inFlight&&operation==='query')return inFlight;if(inFlight)fail('PRIVATE_REQUEST_IN_FLIGHT');return send('query');},
  invalidate(){
   if(disposed)return snapshot();verifiedPreview=null;
   if(!intent){abort();localInput=null;status=validIdentity()&&!blocked?(draft?'ready':'idle'):'auth-required';error=null;armExpiry();}emit();return snapshot();
  },
  dispose(){if(disposed)return;abort();clearTimeout(expiryTimer);expiryTimer=null;disposed=true;identity=null;draft=null;verifiedPreview=null;localInput=null;intent=null;status='idle';error=null;}
 };
}
