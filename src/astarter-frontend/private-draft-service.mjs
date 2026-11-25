import {isDeepStrictEqual} from 'node:util';
import {readPrivateJSONBody} from './private-ui-service.mjs';
import {validatePrivateDraftPreviewInput,validatePrivateDraftAdoptInput,validatePrivateDraftDocument,validatePrivateDraftPreview,validatePrivateDraftCommandResult} from './private-draft-data.mjs';

const ORIGIN='https://astarter.imstark.site',HOST='astarter.imstark.site';
const METHODS=['draftsPreview','draftsGet','draftsAdopt','draftsRequest'];
const ROUTES={'/api/strategy-drafts/preview':'POST','/api/strategy-drafts/get':'GET','/api/strategy-drafts/adopt':'POST','/api/strategy-drafts/request':'GET'};
const STATUSES={AUTH_REQUIRED:401,PRIVATE_AUTH_REQUIRED:401,PRIVATE_FORBIDDEN:403,PRIVATE_TARGET_MISMATCH:403,PRIVATE_REQUEST_INVALID:400,PRIVATE_CONFLICT:409,PRIVATE_UNAVAILABLE:503,PRIVATE_UNCONFIGURED:503,PRIVATE_UI_PROTOCOL:503,ORIGIN_DENIED:403,METHOD_NOT_ALLOWED:405,BODY_TOO_LARGE:413,JSON_REQUIRED:415};
const requestId=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{8,96}$/.test(value);
const draftId=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,96}$/.test(value);
const fault=code=>{throw Object.assign(Error(code),{code});};
function oneQuery(url,key,valid){
 const items=[...url.searchParams];if(items.length!==1||items[0][0]!==key||!valid(items[0][1]))fault('PRIVATE_REQUEST_INVALID');
 return {[key]:items[0][1]};
}
function matchesInput(content,input){return content.source.sourceRequestId===input.sourceRequestId&&isDeepStrictEqual(content.fields,input.fields);}

// The backend resolves the cookie owner and original report. This facade never
// creates identity, stores drafts locally, calls a model or grants execution.
export function createPrivateDraftService({backend}={}){
 const configured=Boolean(METHODS.every(name=>typeof backend?.[name]==='function'));
 return async function handle(req,res){
  if(typeof req.url!=='string'||!/^\/api\/strategy-drafts(?:[/?]|$)/.test(req.url))return false;
  const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));return true;};
  let mutating=false,dispatched=false,id=null;
  try{
   if(req.headers.host!==HOST||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin!==undefined&&req.headers.origin!==ORIGIN||req.method==='POST'&&req.headers.origin!==ORIGIN)fault('ORIGIN_DENIED');
   if(['x-workspace-id','x-user-id','x-owner-ref','x-tenant-id','x-scope-id','x-subject-id'].some(key=>req.headers[key]!==undefined))fault('PRIVATE_REQUEST_INVALID');
   if(req.url.length>2048||req.url.startsWith('//'))fault('PRIVATE_REQUEST_INVALID');
   const url=new URL(req.url,ORIGIN),method=ROUTES[url.pathname];if(url.origin!==ORIGIN||url.hash||!method)fault('PRIVATE_REQUEST_INVALID');
   if(req.method!==method)fault('METHOD_NOT_ALLOWED');mutating=url.pathname==='/api/strategy-drafts/adopt';
   if(method==='POST'&&url.search||method==='GET'&&(req.headers['transfer-encoding']!==undefined||req.headers['content-length']!==undefined&&req.headers['content-length']!=='0'))fault('PRIVATE_REQUEST_INVALID');
   if(!configured)fault('PRIVATE_UNCONFIGURED');
   if(url.pathname==='/api/strategy-drafts/get'){
    const input=oneQuery(url,'draftId',draftId),value=await backend.draftsGet(req,input);
    const result=value===null?null:validatePrivateDraftDocument(value);if(result&&result.draftId!==input.draftId)fault('PRIVATE_UI_PROTOCOL');return send(200,result);
   }
   if(url.pathname==='/api/strategy-drafts/request'){
    const input=oneQuery(url,'requestId',requestId),value=await backend.draftsRequest(req,input);
    return send(200,value===null?null:validatePrivateDraftCommandResult(value,input.requestId));
   }
   const body=await readPrivateJSONBody(req);id=requestId(body.requestId)?body.requestId:null;
   if(!mutating){
    const input=validatePrivateDraftPreviewInput(body);dispatched=true;
    const result=validatePrivateDraftPreview(await backend.draftsPreview(req,input));
    if(result.draftId!==input.draftId||!matchesInput(result.proposal,input))fault('PRIVATE_UI_PROTOCOL');return send(200,result);
   }
   const input=validatePrivateDraftAdoptInput(body);id=input.requestId;dispatched=true;
   const result=validatePrivateDraftCommandResult(await backend.draftsAdopt(req,input),id);
   if(result.draft.draftId!==input.draftId||result.request.expectedRevision!==input.expectedRevision||result.request.workspaceBaseRevision!==input.workspaceRevision||!matchesInput(result.draft.content,input))fault('PRIVATE_UI_PROTOCOL');
   return send(200,result);
  }catch(error){
   let code=typeof error?.code==='string'?error.code:error?.message;
   const unknown=mutating&&dispatched&&(code==='PRIVATE_COMMIT_UNKNOWN'||error?.outcomeUnknown===true||!Object.hasOwn(STATUSES,code)||code==='PRIVATE_UI_PROTOCOL'||code==='PRIVATE_UNAVAILABLE'&&error?.outcomeUnknown!==false);
   if(unknown)return send(409,{error:'PRIVATE_COMMIT_UNKNOWN',...(id?{requestId:id}:{}),queryOriginalRequest:true,executionAuthority:'NONE'});
   if(!Object.hasOwn(STATUSES,code))code='PRIVATE_UNAVAILABLE';if(code==='PRIVATE_AUTH_REQUIRED')code='AUTH_REQUIRED';return send(STATUSES[code],{error:code,executionAuthority:'NONE'});
  }
 };
}
