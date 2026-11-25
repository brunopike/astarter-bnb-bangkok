export const PRIVATE_RESEARCH_CONTRACT='ASTARTER_PRIVATE_RESEARCH_V1';
const BASE='/internal/private/v1/';
const OWNER=['subjectId','scopeId','tenantId','requestId','leaseId','targetId','audience'];
const UI_BASE=['leaseId','targetId','audience'];
const UI_PROFILE_KEYS=['authVersion','permissionProfile'];
const UI_PERMISSIONS=['research:analyze','notifications:read','notifications:write','workspace:read','workspace:write'];
const METHODS=Object.freeze({
 inspectLease:{path:'lease',required:['leaseId','targetId','audience']},
 resolveSession:{path:'session/resolve',required:['tokenDigest','audience','leaseId','targetId','now'],nullable:true},
 get:{path:'research/get',required:OWNER,nullable:true},
 claim:{path:'research/claim',required:[...OWNER,'fingerprint','createdAt','expiresAt','reservedTokens','reservedMicrousd','policy'],mutation:true},
 finish:{path:'research/finish',required:[...OWNER,'claimToken','state','settledTokens','settledMicrousd','providerReceipt'],optional:['result','error','queryOriginalRequest'],mutation:true}
});
const UI_METHODS=Object.freeze({
 inspectLease:METHODS.inspectLease,resolveSession:METHODS.resolveSession,
 notificationsState:{path:'notifications/state',required:[...UI_BASE,'cursor','limit'],optional:['responseVersion']},
 notificationsCommand:{path:'notifications/command',required:[...UI_BASE,'requestId','baseRevision','action','payload'],mutation:true},
 notificationsRequest:{path:'notifications/request',required:[...UI_BASE,'requestId'],nullable:true},
 workspaceState:{path:'workspace/state',required:UI_BASE},
 workspaceSave:{path:'workspace/save',required:[...UI_BASE,'requestId','baseRevision','preferences','drafts','selectedDraftId'],mutation:true},
 workspaceRequest:{path:'workspace/request',required:[...UI_BASE,'requestId'],nullable:true}
});
const DRAFT_METHODS=Object.freeze({
 inspectLease:METHODS.inspectLease,resolveSession:METHODS.resolveSession,
 draftsPreview:{path:'drafts/preview',required:[...UI_BASE,'sourceRequestId','draftId','fields']},
 draftsGet:{path:'drafts/get',required:[...UI_BASE,'draftId'],nullable:true},
 draftsAdopt:{path:'drafts/adopt',required:[...UI_BASE,'sourceRequestId','draftId','fields','requestId','expectedRevision','workspaceRevision','proposalRevision'],mutation:true},
 draftsRequest:{path:'drafts/request',required:[...UI_BASE,'requestId'],nullable:true}
});
const ISSUER_METHODS=Object.freeze({
 issueChallenge:{path:'auth/challenge/issue',required:['challengeHash','nonce','origin','issuedAt','expires','address','chain','message'],optional:UI_PROFILE_KEYS,mutation:true},
 getChallenge:{path:'auth/challenge/get',required:['challengeHash','now'],nullable:true},
 prepareChallenge:{path:'auth/challenge/prepare',required:['challengeHash','nonce','address','chain','message','now'],optional:UI_PROFILE_KEYS,nullable:true,mutation:true},
 consumeChallenge:{path:'auth/challenge/consume',required:['challengeHash','nonce','address','chain','message','now'],optional:UI_PROFILE_KEYS,nullable:true,mutation:true},
 revokeChallenge:{path:'auth/challenge/revoke',required:['challengeHash','now'],boolean:true,mutation:true},
 issueSession:{path:'auth/session/issue',required:['tokenHash','previousTokenHash','challengeHash','claimToken','address','chain','origin','issuedAt','expires','permissions'],optional:UI_PROFILE_KEYS,nullable:true,mutation:true},
 resolveSession:{path:'auth/session/resolve',required:['tokenHash','now'],nullable:true},
 revokeSession:{path:'auth/session/revoke',required:['tokenHash','now'],boolean:true,mutation:true}
});
const REMOTE_ERRORS=new Map([
 [401,new Set(['PRIVATE_AUTH_REQUIRED'])],
 [403,new Set(['PRIVATE_FORBIDDEN','PRIVATE_TARGET_MISMATCH'])],
 [400,new Set(['PRIVATE_REQUEST_INVALID'])],
 [409,new Set(['PRIVATE_COMMIT_UNKNOWN','PRIVATE_CONFLICT','BUDGET_EXCEEDED'])],
 [503,new Set(['PRIVATE_UNCONFIGURED','PRIVATE_UNAVAILABLE'])]
]);
const LIMITS={requestBytes:16384,responseBytes:65536,depth:16};
const secretKey=key=>/^(?:authorization|cookie|setcookie|apikey|accesstoken|refreshtoken|servicetoken|sessiontoken|bearer|password|privatekey|mnemonic|seedphrase|databaseurl|connectionstring|dsn|credential|credentials|secret|token)$/i.test(key.replace(/[_-]/g,''));
const unsafeString=(value,token)=>value.includes(token)||/\b(?:sk-or-v1-|sk-proj-)[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._-]{16,}|\b(?:https?|postgres(?:ql)?):\/\/[^\s/@:]+:[^\s/@]+@/i.test(value);
const fault=(code,unknown=false,status=503)=>Object.assign(Error(code),{code,status,outcomeUnknown:unknown});
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;

// Construction is inert. The owner supplies one reviewed server origin and one
// dedicated service credential; a browser request is never forwarded wholesale.
export function createPrivateResearchClient(options={}){return createPrivateClient(options,METHODS,false);}
export function createPrivateUIClient(options={}){return createPrivateClient(options,UI_METHODS,false);}
export function createPrivateDraftClient(options={}){return createPrivateClient(options,DRAFT_METHODS,false);}
// Parent runtime must provision this with a distinct issuer credential. It has no
// research routes, cookie forwarding or generic RPC method.
export function createPrivateIssuerClient(options={}){return createPrivateClient(options,ISSUER_METHODS,true);}
function createPrivateClient({origin='',token='',sessionDigest='',fetchImpl=globalThis.fetch,timeoutMs=5000},methods,issuer){
 let url;try{url=new URL(origin);}catch{}
 const configured=Boolean(typeof origin==='string'&&url?.protocol==='https:'&&url.origin===origin&&url.pathname==='/'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&typeof token==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(token)&&typeof fetchImpl==='function'&&Number.isSafeInteger(timeoutMs)&&timeoutMs>=50&&timeoutMs<=15000);

 const remoteErrors=new WeakSet();
 function clean(value,{method,input=false,path=[],depth=0}={}){
  if(depth>LIMITS.depth)throw fault('PRIVATE_RPC_PROTOCOL');
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))throw fault('PRIVATE_RPC_PROTOCOL');return;}
  if(typeof value==='string'){if(unsafeString(value,token))throw fault('PRIVATE_RPC_PROTOCOL');return;}
  if(!Array.isArray(value)&&!plain(value))throw fault('PRIVATE_RPC_PROTOCOL');
  for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
   if(Array.isArray(value)&&key==='length')continue;
   if(!Object.hasOwn(descriptor,'value')||['__proto__','prototype','constructor'].includes(key)||secretKey(key))throw fault('PRIVATE_RPC_PROTOCOL');
   if(['tokenHash','challengeHash','previousTokenHash'].includes(key)&&!(key==='previousTokenHash'&&descriptor.value===null)&&!(typeof descriptor.value==='string'&&/^[a-f0-9]{64}$/.test(descriptor.value)))throw fault('PRIVATE_RPC_PROTOCOL');
   if(key==='claimToken'){
    const allowed=path.length===0&&(issuer?input&&method==='issueSession'||!input&&method==='consumeChallenge':input&&method==='finish'||!input&&method==='claim'&&value.acquired===true);
    if(!allowed||issuer&&!(typeof descriptor.value==='string'&&descriptor.value.length>0&&descriptor.value.length<=128&&!/[\u0000-\u001f\u007f]/.test(descriptor.value)))throw fault('PRIVATE_RPC_PROTOCOL');
   }
   clean(descriptor.value,{method,input,path:[...path,key],depth:depth+1});
  }
 }
 function serialize(method,payload){
  const spec=methods[method];
  try{
   if(!plain(payload)||!spec.required.every(key=>Object.hasOwn(payload,key))||Object.keys(payload).some(key=>![...spec.required,...(spec.optional||[])].includes(key)))throw fault('PRIVATE_RPC_INVALID_REQUEST');
   clean(payload,{method,input:true});
   if(method==='notificationsState'&&Object.hasOwn(payload,'responseVersion')&&payload.responseVersion!==2)throw fault('PRIVATE_RPC_INVALID_REQUEST');
   const uiProfile=issuer&&spec.optional===UI_PROFILE_KEYS&&(Object.hasOwn(payload,'authVersion')||Object.hasOwn(payload,'permissionProfile'));
   if(uiProfile&&(payload.authVersion!==2||payload.permissionProfile!=='private-ui-v2'))throw fault('PRIVATE_RPC_INVALID_REQUEST');
   if(issuer&&method==='issueSession'&&JSON.stringify(payload.permissions)!==JSON.stringify(uiProfile?UI_PERMISSIONS:['research:analyze'])){
    throw fault('PRIVATE_RPC_INVALID_REQUEST');
   }
   const body=JSON.stringify(payload);
   if(Buffer.byteLength(body)>LIMITS.requestBytes)throw fault('PRIVATE_RPC_INVALID_REQUEST');
   return body;
  }catch{throw fault('PRIVATE_RPC_INVALID_REQUEST');}
 }
 async function invoke(method,payload){
  if(!configured)throw fault('PRIVATE_RPC_UNCONFIGURED');
  const bound=typeof sessionDigest==='string'&&/^[a-f0-9]{64}$/.test(sessionDigest);
  // Construct this client once per outer HTTP request, after reading its opaque
  // session credential. Neither owner IDs nor arbitrary browser headers bind it.
  let matches=method!=='resolveSession';try{if(!issuer&&method==='resolveSession')matches=Object.getOwnPropertyDescriptor(payload||{},'tokenDigest')?.value===sessionDigest;}catch{}
  if(!issuer&&(!bound||!matches))throw fault('AUTH_REQUIRED',false,401);
  const body=serialize(method,payload),spec=methods[method],endpoint=origin+BASE+spec.path;
  const controller=new AbortController();let reader=null,timer,expired=false;
  const cancel=()=>{controller.abort();if(reader)void reader.cancel().catch(()=>{});};
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;cancel();reject(fault(spec.mutation?'PRIVATE_RPC_OUTCOME_UNKNOWN':'PRIVATE_RPC_UNAVAILABLE',Boolean(spec.mutation)));},timeoutMs);});
  async function call(){
   const headers={Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json',...(!issuer?{'X-Astarter-Private-Session-Digest':sessionDigest}:{})};
   const response=await fetchImpl(endpoint,{method:'POST',headers,body,credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',redirect:'error',signal:controller.signal});
   if(expired)throw fault('PRIVATE_RPC_UNAVAILABLE');
   if(response?.redirected||response?.url&&response.url!==endpoint||!/^application\/json(?:\s*;.*)?$/i.test(response?.headers?.get('content-type')||'')||!response?.body)throw fault('PRIVATE_RPC_PROTOCOL');
   const length=response.headers.get('content-length');
   if(length!==null&&(!/^\d+$/.test(length)||Number(length)>LIMITS.responseBytes))throw fault('PRIVATE_RPC_PROTOCOL');
   reader=response.body.getReader();const chunks=[];let size=0;
   for(;;){
    const {done,value}=await reader.read();if(expired)throw fault('PRIVATE_RPC_UNAVAILABLE');if(done)break;
    if(!(value instanceof Uint8Array))throw fault('PRIVATE_RPC_PROTOCOL');
    size+=value.byteLength;if(size>LIMITS.responseBytes)throw fault('PRIVATE_RPC_PROTOCOL');chunks.push(Buffer.from(value));
   }
   const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
   if(raw.includes(token))throw fault('PRIVATE_RPC_PROTOCOL');
   const envelope=JSON.parse(raw);
   if(!plain(envelope)||Object.keys(envelope).length!==2||envelope.contract!==PRIVATE_RESEARCH_CONTRACT)throw fault('PRIVATE_RPC_PROTOCOL');
   if(!response.ok){
    if(!REMOTE_ERRORS.get(response.status)?.has(envelope.code))throw fault('PRIVATE_RPC_PROTOCOL');
    const issue=fault(envelope.code,envelope.code==='PRIVATE_COMMIT_UNKNOWN'||Boolean(spec.mutation&&envelope.code==='PRIVATE_UNAVAILABLE'),response.status);remoteErrors.add(issue);throw issue;
   }
   if(!Object.hasOwn(envelope,'result')||!(plain(envelope.result)||spec.nullable&&envelope.result===null||spec.boolean&&typeof envelope.result==='boolean'))throw fault('PRIVATE_RPC_PROTOCOL');
   clean(envelope.result,{method});return envelope.result;
  }
  try{return await Promise.race([call(),deadline]);}
  catch(issue){
   if(remoteErrors.has(issue))throw issue;
   if(spec.mutation)throw fault('PRIVATE_RPC_OUTCOME_UNKNOWN',true);
   throw fault(issue?.message==='PRIVATE_RPC_PROTOCOL'?'PRIVATE_RPC_PROTOCOL':'PRIVATE_RPC_UNAVAILABLE');
  }finally{clearTimeout(timer);cancel();}
 }
 return Object.freeze({configured,contract:PRIVATE_RESEARCH_CONTRACT,...Object.fromEntries(Object.keys(methods).map(method=>[method,payload=>invoke(method,payload)]))});
}
