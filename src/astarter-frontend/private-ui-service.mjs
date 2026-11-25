import {validatePrivateWorkspaceState,validatePrivateNotificationState,validatePrivateNotificationStateV2,validatePrivateUICommandResult,validatePrivateUIWorkspaceInput,validatePrivateUINotificationCommand} from './private-ui-data.mjs';

const ORIGIN='https://astarter.imstark.site',HOST='astarter.imstark.site',MAX_BYTES=16384;
const METHODS=['notificationsState','notificationsCommand','notificationsRequest','workspaceState','workspaceSave','workspaceRequest'];
const requestId=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{8,96}$/.test(value);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const forbidden=key=>/^(?:proto|prototype|constructor|owner|ownerref|subjectid|tenantid|scope|scopeid|userid|person|address|authorization|cookie|token|apikey|secret|password|privatekey|mnemonic|credentials?)$/i.test(key.replace(/[_-]/g,''));
const external=new Set(['telegram-link','email-code','email-verify','disconnect','test','send']);
const statuses={AUTH_REQUIRED:401,PRIVATE_AUTH_REQUIRED:401,PRIVATE_FORBIDDEN:403,PRIVATE_TARGET_MISMATCH:403,PRIVATE_REQUEST_INVALID:400,PRIVATE_CONFLICT:409,PRIVATE_UNAVAILABLE:503,PRIVATE_UNCONFIGURED:503,PRIVATE_UI_PROTOCOL:503,CHANNEL_DISABLED:503,ORIGIN_DENIED:403,METHOD_NOT_ALLOWED:405,BODY_TOO_LARGE:413,JSON_REQUIRED:415};
const fault=code=>{throw Object.assign(Error(code),{code});};
function structural(value,depth=0){
 if(depth>16)fault('PRIVATE_REQUEST_INVALID');
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
 if(!Array.isArray(value)&&!plain(value))fault('PRIVATE_REQUEST_INVALID');
 for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
  if(Array.isArray(value)&&key==='length')continue;
  if(!Object.hasOwn(descriptor,'value')||forbidden(key))fault('PRIVATE_REQUEST_INVALID');structural(descriptor.value,depth+1);
 }
}
async function readBody(req){
 if(typeof req.headers['content-type']!=='string'||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']))fault('JSON_REQUIRED');
 const length=req.headers['content-length'];if(length!==undefined&&(typeof length!=='string'||!/^\d+$/.test(length)||Number(length)>MAX_BYTES))fault('BODY_TOO_LARGE');
 let raw,value;
 if(req.body!==undefined&&plain(req.body)){
  structural(req.body);try{raw=JSON.stringify(req.body);}catch{fault('PRIVATE_REQUEST_INVALID');}if(Buffer.byteLength(raw)>MAX_BYTES)fault('BODY_TOO_LARGE');value=req.body;
 }else{
  let bytes;
  if(req.body!==undefined){if(typeof req.body!=='string'&&!Buffer.isBuffer(req.body))fault('PRIVATE_REQUEST_INVALID');bytes=Buffer.from(req.body);}
  else{const chunks=[];let size=0;for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.byteLength;if(size>MAX_BYTES)fault('BODY_TOO_LARGE');chunks.push(bytes);}bytes=Buffer.concat(chunks);}
  if(bytes.byteLength>MAX_BYTES)fault('BODY_TOO_LARGE');if(length!==undefined&&Number(length)!==bytes.byteLength)fault('PRIVATE_REQUEST_INVALID');
  try{raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=JSON.parse(raw);}catch{fault('PRIVATE_REQUEST_INVALID');}
  structural(value);
 }
 if(!plain(value))fault('PRIVATE_REQUEST_INVALID');return value;
}
export {readBody as readPrivateJSONBody};
function query(url,allowed){
 const seen=new Set();for(const [key] of url.searchParams){if(seen.has(key)||!allowed.includes(key))fault('PRIVATE_REQUEST_INVALID');seen.add(key);}return url.searchParams;
}
function stateQuery(url){
 const p=query(url,['cursor','limit','responseVersion']),cursor=p.get('cursor'),raw=p.get('limit'),version=p.get('responseVersion');
 if(version!==null&&version!=='2')fault('PRIVATE_REQUEST_INVALID');
 if(cursor!==null&&!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)||raw!==null&&!/^[1-9]\d{0,2}$/.test(raw))fault('PRIVATE_REQUEST_INVALID');
 const limit=raw===null?20:Number(raw);if(limit>50)fault('PRIVATE_REQUEST_INVALID');return {cursor,limit,...(version===null?{}:{responseVersion:2})};
}
function originalRequest(url){const p=query(url,['requestId']),id=p.get('requestId');if(p.size!==1||!requestId(id))fault('PRIVATE_REQUEST_INVALID');return {requestId:id};}

// Authentication, owner mapping, revision CAS and durable idempotency remain with
// backend. This façade creates no identity, local persistence or external sender.
export function createPrivateUIService({backend,now=Date.now}={}){
 const configured=Boolean(METHODS.every(name=>typeof backend?.[name]==='function')&&typeof now==='function');
 return async function handle(req,res){
  if(typeof req.url!=='string'||!/^\/api\/(?:notifications|workspace)(?:[/?]|$)/.test(req.url))return false;
  const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));return true;};
  let mutating=false,dispatched=false,id=null;
  try{
   if(req.headers.host!==HOST||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin!==undefined&&req.headers.origin!==ORIGIN||req.method==='POST'&&req.headers.origin!==ORIGIN)fault('ORIGIN_DENIED');
   if(['x-workspace-id','x-user-id','x-owner-ref','x-tenant-id','x-scope-id','x-subject-id'].some(key=>req.headers[key]!==undefined))fault('PRIVATE_REQUEST_INVALID');
   if(req.url.length>2048||req.url.startsWith('//'))fault('PRIVATE_REQUEST_INVALID');
   const url=new URL(req.url,ORIGIN);if(url.origin!==ORIGIN||url.hash)fault('PRIVATE_REQUEST_INVALID');
   const routes={'/api/notifications/state':'GET','/api/notifications/command':'POST','/api/notifications/request':'GET','/api/workspace/state':'GET','/api/workspace/save':'POST','/api/workspace/request':'GET'},method=routes[url.pathname];
   if(!method)fault('PRIVATE_REQUEST_INVALID');if(req.method!==method)fault('METHOD_NOT_ALLOWED');
   mutating=method==='POST';if(mutating&&url.search)fault('PRIVATE_REQUEST_INVALID');
   if(!mutating&&(req.headers['transfer-encoding']!==undefined||req.headers['content-length']!==undefined&&req.headers['content-length']!=='0'))fault('PRIVATE_REQUEST_INVALID');
   if(!configured)fault('PRIVATE_UNCONFIGURED');const at=now();if(!Number.isSafeInteger(at)||at<0)fault('PRIVATE_UNAVAILABLE');
   let result;
   if(url.pathname==='/api/notifications/state'){const input=stateQuery(url);dispatched=true;result=await backend.notificationsState(req,input);return send(200,(input.responseVersion===2?validatePrivateNotificationStateV2:validatePrivateNotificationState)(result));}
   if(url.pathname==='/api/workspace/state'){query(url,[]);dispatched=true;result=await backend.workspaceState(req);return send(200,validatePrivateWorkspaceState(result));}
   if(url.pathname.endsWith('/request')){
    const input=originalRequest(url),domain=url.pathname.includes('/notifications/')?'notifications':'workspace';id=input.requestId;dispatched=true;result=await backend[domain==='notifications'?'notificationsRequest':'workspaceRequest'](req,input);
    return send(200,result===null?null:validatePrivateUICommandResult(result,domain,id));
   }
   const body=await readBody(req);id=requestId(body.requestId)?body.requestId:null;
   if(url.pathname==='/api/notifications/command'){
    if(body.action==='event')fault('PRIVATE_FORBIDDEN');
    if(external.has(body.action))fault('CHANNEL_DISABLED');
    const input=validatePrivateUINotificationCommand(body);id=input.requestId;dispatched=true;result=validatePrivateUICommandResult(await backend.notificationsCommand(req,input),'notifications',id);if(result.request.baseRevision!==input.baseRevision)fault('PRIVATE_UI_PROTOCOL');return send(200,result);
   }
   const input=validatePrivateUIWorkspaceInput(body);id=input.requestId;dispatched=true;result=validatePrivateUICommandResult(await backend.workspaceSave(req,input),'workspace',id);if(result.request.baseRevision!==input.baseRevision)fault('PRIVATE_UI_PROTOCOL');return send(200,result);
  }catch(error){
   let code=typeof error?.code==='string'?error.code:error?.message;
   const unknown=mutating&&dispatched&&(code==='PRIVATE_COMMIT_UNKNOWN'||error?.outcomeUnknown===true||!Object.hasOwn(statuses,code)||code==='PRIVATE_UI_PROTOCOL'||code==='PRIVATE_UNAVAILABLE'&&error?.outcomeUnknown!==false);
   if(unknown)return send(409,{error:'PRIVATE_COMMIT_UNKNOWN',...(id?{requestId:id}:{}),queryOriginalRequest:true,executionAuthority:'NONE'});
   if(!Object.hasOwn(statuses,code))code='PRIVATE_UNAVAILABLE';if(code==='PRIVATE_AUTH_REQUIRED')code='AUTH_REQUIRED';return send(statuses[code],{error:code,executionAuthority:'NONE'});
  }
 };
}
