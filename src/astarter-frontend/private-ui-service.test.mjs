import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {createPrivateUIService} from './private-ui-service.mjs';
import {CATALOG} from './strategy-catalog.mjs';

const HOST='astarter.imstark.site',ORIGIN='https://'+HOST,NOW=Date.UTC(2026,10,16,14);
const notification=(patch={})=>({requestId:'notification-request-0001',baseRevision:0,action:'save',payload:{events:['orders','risk'],enabled:{telegram:false,email:false},inapp:true},...patch});
const workspace=(patch={})=>({requestId:'workspace-request-0001',baseRevision:0,preferences:{workbenchFilter:'all',workbenchFocusAsset:'BTC',watchedAssets:[]},drafts:[],selectedDraftId:null,...patch});
const SCOPE='wallet:56:0x'+'a'.repeat(40);
const workspaceState=(revision=0,fields={})=>({schema:'private-workspace-v1',scope:SCOPE,revision,updatedAt:NOW,preferences:workspace().preferences,drafts:[],selectedDraftId:null,executionAuthority:'NONE',...fields});
const notificationState=(revision=0,fields={})=>({schema:'private-notifications-v1',scope:SCOPE,revision,updatedAt:NOW,inapp:true,events:['orders','risk','research'],services:{telegram:{available:false,error:'CHANNEL_DISABLED'},email:{available:false,error:'CHANNEL_DISABLED'}},channels:{telegram:{channel:'telegram',label:'',enabled:0,verified:0},email:{channel:'email',label:'',enabled:0,verified:0}},deliveries:[],inbox:[],unreadCount:0,nextCursor:null,mode:'server-research-only',...fields});
const receipt=(domain,input,state)=>({request:{schema:'private-ui-command-v1',domain,requestId:input.requestId,status:'applied',baseRevision:input.baseRevision,revision:state.revision,appliedAt:NOW},state});
const failure=(code,outcomeUnknown)=>Object.assign(Error(code),{code,...(outcomeUnknown===undefined?{}:{outcomeUnknown})});
function fixture(overrides={}){
 const calls=[];const backend=Object.fromEntries(['notificationsState','notificationsCommand','notificationsRequest','workspaceState','workspaceSave','workspaceRequest'].map(method=>[method,async(context,input)=>{calls.push({method,context,input});return method.endsWith('Request')?null:{};}]));
 for(const [method,run] of Object.entries(overrides))backend[method]=async(context,input)=>{calls.push({method,context,input});return run(context,input);};
 return {calls,backend,handle:createPrivateUIService({backend,now:()=>NOW})};
}
async function invoke(handle,{url='/api/workspace/state',method='GET',body,raw,headers={},parsed}={}){
 const bytes=raw!==undefined?Buffer.from(raw):body!==undefined?Buffer.from(JSON.stringify(body)):Buffer.alloc(0),req=Object.assign(Readable.from(bytes.byteLength?[bytes]:[]),{url,method,headers:{host:HOST,...(method==='POST'?{origin:ORIGIN,'content-type':'application/json','content-length':String(bytes.byteLength)}:{}),...headers}});
 if(parsed!==undefined)req.body=parsed;
 let status,data,responseHeaders;const handled=await handle(req,{writeHead(value,h){status=value;responseHeaders=h;},end(value){data=JSON.parse(value);}});return {handled,status,body:data,headers:responseHeaders,req};
}
function secureError(value,status,code){assert.equal(value.status,status);assert.equal(value.body.error,code);assert.equal(value.body.executionAuthority,'NONE');assert.equal(value.headers['Cache-Control'],'no-store');assert.equal(value.headers['X-Content-Type-Options'],'nosniff');assert.doesNotMatch(JSON.stringify(value.body),/postgres-private|provider-private|api-key-private/);}

test('notification state v2 is opt-in, exact and leaves legacy state and original receipts unchanged',async()=>{
 const old=notificationState(),fresh={...old,schema:'private-notifications-v2',reminderUnreadCount:0};
 const f=fixture({notificationsState:(_req,input)=>input.responseVersion===2?fresh:old});
 assert.deepEqual((await invoke(f.handle,{url:'/api/notifications/state'})).body,old);assert.deepEqual(f.calls[0].input,{cursor:null,limit:20});
 const v2=await invoke(f.handle,{url:'/api/notifications/state?responseVersion=2'});assert.equal(v2.status,200);assert.deepEqual(v2.body,fresh);assert.deepEqual(f.calls[1].input,{cursor:null,limit:20,responseVersion:2});
 for(const query of ['responseVersion=1','responseVersion=02','responseVersion=2.0','responseVersion=true','responseVersion=','responseVersion=2&responseVersion=2'])secureError(await invoke(f.handle,{url:'/api/notifications/state?'+query}),400,'PRIVATE_REQUEST_INVALID');
 assert.equal(f.calls.length,2);
 for(const [query,returned] of [['',fresh],['?responseVersion=2',old]]){const bad=fixture({notificationsState:()=>returned});secureError(await invoke(bad.handle,{url:'/api/notifications/state'+query}),503,'PRIVATE_UI_PROTOCOL');}
});

test('construction is inert and unavailable services return a secure 503 without manufacturing an identity',async()=>{
 const handle=createPrivateUIService();secureError(await invoke(handle),503,'PRIVATE_UNCONFIGURED');const f=fixture();assert.equal(f.calls.length,0);assert.equal((await invoke(f.handle,{url:'/unrelated'})).handled,false);assert.equal(f.calls.length,0);
});
test('host, exact POST Origin and cross-site checks run before any backend call',async()=>{
 const f=fixture();for(const options of [{headers:{host:'evil.example'}},{headers:{origin:'https://evil.example'}},{headers:{'sec-fetch-site':'cross-site'}},{method:'POST',url:'/api/workspace/save',body:workspace(),headers:{origin:undefined}},{method:'POST',url:'/api/workspace/save',body:workspace(),headers:{origin:'https://astarter.imstark.site.evil.example'}}])secureError(await invoke(f.handle,options),403,'ORIGIN_DENIED');assert.equal(f.calls.length,0);
});
test('route and method whitelists reject unknown paths, POST queries and duplicate or arbitrary GET parameters',async()=>{
 const f=fixture();
 for(const url of ['/api/workspace/approve','/api/workspace/state?ownerRef=attacker','/api/notifications/state?limit=1&limit=2','/api/notifications/state?cursor=a&%63ursor=b','/api/notifications/state?scope=public','/api/workspace/request?requestId=request-0001&requestId=request-0002','/api/workspace/request','/api/workspace/request?requestId=short'])secureError(await invoke(f.handle,{url}),400,'PRIVATE_REQUEST_INVALID');
 secureError(await invoke(f.handle,{url:'/api/workspace/save?x=1',method:'POST',body:workspace()}),400,'PRIVATE_REQUEST_INVALID');secureError(await invoke(f.handle,{url:'/api/workspace/state',method:'POST',body:{}}),405,'METHOD_NOT_ALLOWED');secureError(await invoke(f.handle,{url:'/api/notifications/command'}),405,'METHOD_NOT_ALLOWED');assert.equal(f.calls.length,0);
});
test('GET requests do not carry mutation bodies or caller-supplied owner and scope headers',async()=>{
 const f=fixture();for(const headers of [{'content-length':'1'},{'transfer-encoding':'chunked'},{'x-workspace-id':'public'},{'x-user-id':'attacker'},{'x-owner-ref':'attacker'},{'x-tenant-id':'public'},{'x-scope-id':'public'},{'x-subject-id':'attacker'}])secureError(await invoke(f.handle,{headers}),400,'PRIVATE_REQUEST_INVALID');assert.equal(f.calls.length,0);
});
test('strict JSON, UTF-8, content-length and 16KB limits reject malformed input before writes',async()=>{
 const f=fixture(),url='/api/workspace/save';
 secureError(await invoke(f.handle,{url,method:'POST',body:workspace(),headers:{'content-type':'text/plain'}}),415,'JSON_REQUIRED');
 for(const raw of ['{','[]','null',Buffer.from([0xc3,0x28])])secureError(await invoke(f.handle,{url,method:'POST',raw}),400,'PRIVATE_REQUEST_INVALID');
 secureError(await invoke(f.handle,{url,method:'POST',raw:' '.repeat(16385)}),413,'BODY_TOO_LARGE');secureError(await invoke(f.handle,{url,method:'POST',body:workspace(),headers:{'content-length':'999999'}}),413,'BODY_TOO_LARGE');secureError(await invoke(f.handle,{url,method:'POST',body:workspace(),headers:{'content-length':'1'}}),400,'PRIVATE_REQUEST_INVALID');assert.equal(f.calls.length,0);
});
test('prototype, credential, owner and scope fields are never accepted as workspace or notification input',async()=>{
 const f=fixture();for(const [key,value] of [['ownerRef','wallet:56:attacker'],['subjectId','attacker'],['scope','PUBLIC'],['tenant_id','attacker'],['apiKey','api-key-private'],['privateKey','private'],['credentials',{}],['constructor',{}]])secureError(await invoke(f.handle,{url:'/api/workspace/save',method:'POST',body:{...workspace(),[key]:value}}),400,'PRIVATE_REQUEST_INVALID');
 secureError(await invoke(f.handle,{url:'/api/workspace/save',method:'POST',raw:JSON.stringify(workspace()).replace('"preferences":{','"preferences":{"__proto__":{},')}),400,'PRIVATE_REQUEST_INVALID');
 const accessor=workspace();Object.defineProperty(accessor,'baseRevision',{enumerable:true,get(){throw Error('postgres-private');}});secureError(await invoke(f.handle,{url:'/api/workspace/save',method:'POST',parsed:accessor}),400,'PRIVATE_REQUEST_INVALID');assert.equal(f.calls.length,0);
});
test('workspace input accepts only preferences and draft metadata, never account values or execution permission',async()=>{
 const f=fixture();for(const body of [workspace({requestId:'short'}),workspace({baseRevision:-1}),workspace({baseRevision:1.2}),workspace({baseRevision:Number.MAX_SAFE_INTEGER+1}),workspace({amount:100}),workspace({risk:{cap:100}}),workspace({ledger:{cash:100}}),workspace({authorization:{execution:true}}),workspace({preferences:{...workspace().preferences,workbenchFilter:'private'}}),workspace({preferences:{...workspace().preferences,workbenchFocusAsset:'invalid'}}),workspace({selectedDraftId:'missing'}),workspace({drafts:Array.from({length:51},(_,i)=>({id:'draft-'+i,strategyId:'S03',name:'Test'}))})])secureError(await invoke(f.handle,{url:'/api/workspace/save',method:'POST',body}),400,'PRIVATE_REQUEST_INVALID');assert.equal(f.calls.length,0);
});
test('notification writes restrict events, disabled external channels, in-app state and mark-read batches',async()=>{
 const f=fixture();for(const body of [notification({payload:{...notification().payload,events:['orders','orders']}}),notification({payload:{...notification().payload,events:['withdrawals']}}),notification({payload:{...notification().payload,enabled:{telegram:true,email:false}}}),notification({payload:{...notification().payload,inapp:'true'}}),notification({action:'mark-read',payload:{ids:[]}}),notification({action:'mark-read',payload:{ids:Array.from({length:51},(_,i)=>'notice-'+i)}}),notification({action:'approve-trade'})])secureError(await invoke(f.handle,{url:'/api/notifications/command',method:'POST',body}),400,'PRIVATE_REQUEST_INVALID');assert.equal(f.calls.length,0);
});
test('outbound channels stay disabled and client event publication is forbidden without contacting a sender',async()=>{
 const f=fixture();for(const action of ['telegram-link','email-code','email-verify','disconnect','test','send'])secureError(await invoke(f.handle,{url:'/api/notifications/command',method:'POST',body:notification({action,payload:{}})}),503,'CHANNEL_DISABLED');secureError(await invoke(f.handle,{url:'/api/notifications/command',method:'POST',body:notification({action:'event',payload:{}})}),403,'PRIVATE_FORBIDDEN');assert.equal(f.calls.length,0);
});
test('backend owns real session and permissions on every request, including expiry and request lookup',async()=>{
 const f=fixture({workspaceState:()=>{throw failure('AUTH_REQUIRED');},notificationsState:()=>{throw failure('PRIVATE_FORBIDDEN');},workspaceSave:()=>{throw failure('AUTH_REQUIRED');},workspaceRequest:()=>{throw failure('AUTH_REQUIRED');}});
 secureError(await invoke(f.handle),401,'AUTH_REQUIRED');secureError(await invoke(f.handle,{url:'/api/notifications/state'}),403,'PRIVATE_FORBIDDEN');secureError(await invoke(f.handle,{url:'/api/workspace/save',method:'POST',body:workspace()}),401,'AUTH_REQUIRED');secureError(await invoke(f.handle,{url:'/api/workspace/request?requestId=workspace-request-0001'}),401,'AUTH_REQUIRED');assert.equal(f.calls.length,4);
});
test('a missing original receipt remains null rather than proving that the mutation failed',async()=>{
 const f=fixture();for(const domain of ['workspace','notifications']){const id=domain+'-request-0001',r=await invoke(f.handle,{url:'/api/'+domain+'/request?requestId='+id});assert.equal(r.status,200);assert.equal(r.body,null);assert.deepEqual(f.calls.at(-1).input,{requestId:id});}
});
test('uncertain writes return the original request ID and never retry or manufacture an applied receipt',async()=>{
 const f=fixture({workspaceSave:()=>{throw Error('postgres-private credential');},notificationsCommand:()=>{throw failure('PRIVATE_COMMIT_UNKNOWN',true);}});
 for(const [url,body] of [['/api/workspace/save',workspace()],['/api/notifications/command',notification()]]){const r=await invoke(f.handle,{url,method:'POST',body});secureError(r,409,'PRIVATE_COMMIT_UNKNOWN');assert.equal(r.body.requestId,body.requestId);assert.equal(r.body.queryOriginalRequest,true);assert.equal(r.body.state,undefined);assert.equal(r.body.request,undefined);}
 assert.equal(f.calls.length,2);const queryResult=await invoke(f.handle,{url:'/api/workspace/request?requestId=workspace-request-0001'});assert.equal(queryResult.body,null);assert.equal(f.calls.length,3);
});
test('known revision conflicts and explicit unsent failures remain distinguishable from unknown outcomes',async()=>{
 const f=fixture({workspaceSave:()=>{throw failure('PRIVATE_CONFLICT',false);},notificationsCommand:()=>{throw failure('PRIVATE_UNAVAILABLE',false);}});secureError(await invoke(f.handle,{url:'/api/workspace/save',method:'POST',body:workspace()}),409,'PRIVATE_CONFLICT');secureError(await invoke(f.handle,{url:'/api/notifications/command',method:'POST',body:notification()}),503,'PRIVATE_UNAVAILABLE');assert.equal(f.calls.length,2);
});
test('malformed backend states and receipts fail closed without disclosing provider text or accepting fake applied state',async()=>{
 const f=fixture({workspaceState:()=>({schema:'private-workspace-v1',ownerRef:'provider-private',secret:'api-key-private'}),notificationsState:()=>({body:'provider-private'}),workspaceSave:()=>({request:{status:'applied'},state:{secret:'api-key-private'}})});
 secureError(await invoke(f.handle),503,'PRIVATE_UI_PROTOCOL');secureError(await invoke(f.handle,{url:'/api/notifications/state'}),503,'PRIVATE_UI_PROTOCOL');const written=await invoke(f.handle,{url:'/api/workspace/save',method:'POST',body:workspace()});secureError(written,409,'PRIVATE_COMMIT_UNKNOWN');assert.equal(written.body.requestId,workspace().requestId);
});
test('HTTP event streams traverse the façade with native query semantics and no real network backend',async t=>{
 const f=fixture({workspaceState:()=>{throw failure('AUTH_REQUIRED');}}),server=createServer((req,res)=>{void f.handle(req,res);});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const output=await new Promise((resolve,reject)=>{const req=httpRequest('http://127.0.0.1:'+server.address().port+'/api/workspace/state',{headers:{Host:HOST}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.end();});assert.equal(output.status,401);assert.equal(output.body.error,'AUTH_REQUIRED');assert.equal(f.calls.length,1);assert.equal(f.calls[0].context.headers.host,HOST);
});
test('canonical states pass through exactly and notification paging defaults to twenty with a fifty-row ceiling',async()=>{
 const f=fixture({workspaceState:()=>workspaceState(),notificationsState:()=>notificationState()});
 const w=await invoke(f.handle),n=await invoke(f.handle,{url:'/api/notifications/state'});assert.equal(w.status,200);assert.deepEqual(w.body,workspaceState());assert.equal(n.status,200);assert.deepEqual(n.body,notificationState());assert.equal(n.body.executionAuthority,undefined);assert.deepEqual(f.calls[1].input,{cursor:null,limit:20});assert.equal(f.calls[0].context,w.req);
 const cursor='a'.repeat(510)+'_-';await invoke(f.handle,{url:'/api/notifications/state?cursor='+cursor+'&limit=50'});assert.deepEqual(f.calls.at(-1).input,{cursor,limit:50});const count=f.calls.length;
 for(const url of ['/api/notifications/state?limit=0','/api/notifications/state?limit=51','/api/notifications/state?limit=100','/api/notifications/state?limit=1e1','/api/notifications/state?cursor=','/api/notifications/state?cursor=a:b','/api/notifications/state?cursor='+'a'.repeat(513)])secureError(await invoke(f.handle,{url}),400,'PRIVATE_REQUEST_INVALID');assert.equal(f.calls.length,count);
});
test('notification canonical input ordering, mark-read and original-receipt lookup use the same request ID',async()=>{
 const saved=new Map(),f=fixture({notificationsCommand:(_req,input)=>{const state=notificationState(input.baseRevision+1,input.action==='save'?{events:input.payload.events,inapp:input.payload.inapp}:{}),result=receipt('notifications',input,state);saved.set(input.requestId,result);return result;},notificationsRequest:(_req,input)=>saved.get(input.requestId)||null});
 const input=notification({payload:{events:['research','orders','risk'],enabled:{telegram:false,email:false},inapp:false}}),r=await invoke(f.handle,{url:'/api/notifications/command',method:'POST',body:input});assert.equal(r.status,200);assert.deepEqual(f.calls[0].input.payload.events,['orders','risk','research']);assert.equal(r.body.request.requestId,input.requestId);assert.equal(r.body.state.inapp,false);assert.equal(r.body.executionAuthority,undefined);
 const read=await invoke(f.handle,{url:'/api/notifications/request?requestId='+input.requestId});assert.equal(read.status,200);assert.deepEqual(read.body,r.body);assert.deepEqual(f.calls.at(-1).input,{requestId:input.requestId});
 const marked=await invoke(f.handle,{url:'/api/notifications/command',method:'POST',body:notification({requestId:'read-request-0001',baseRevision:1,action:'mark-read',payload:{ids:['notice-0001']}})});assert.equal(marked.status,200);assert.equal(marked.body.request.revision,2);assert.deepEqual(f.calls.at(-1).input.payload,{ids:['notice-0001']});
});
test('workspace save persists only canonical preferences and draft metadata and returns the exact applied receipt',async()=>{
 let saved=null;const f=fixture({workspaceSave:(_req,input)=>{saved=receipt('workspace',input,workspaceState(input.baseRevision+1,{preferences:input.preferences,drafts:input.drafts,selectedDraftId:input.selectedDraftId}));return saved;},workspaceRequest:()=>saved});
 const body=workspace({preferences:{workbenchFilter:'tracked',workbenchFocusAsset:'ETH',watchedAssets:[]},drafts:[{id:'draft-ui-0001',strategyId:CATALOG[0].id,name:'观察配置'}],selectedDraftId:'draft-ui-0001'}),r=await invoke(f.handle,{url:'/api/workspace/save',method:'POST',body});assert.equal(r.status,200);assert.deepEqual(f.calls[0].input,body);assert.equal(r.body.request.status,'applied');assert.equal(r.body.state.selectedDraftId,'draft-ui-0001');assert.equal(r.body.state.executionAuthority,'NONE');assert.equal(r.body.state.amount,undefined);assert.equal(r.body.state.authorization,undefined);
 const read=await invoke(f.handle,{url:'/api/workspace/request?requestId='+body.requestId});assert.deepEqual(read.body,r.body);
});
test('a valid-looking receipt with the wrong base revision cannot acknowledge this POST',async()=>{
 const f=fixture({workspaceSave:(_req,input)=>receipt('workspace',{...input,baseRevision:4},workspaceState(5))});const r=await invoke(f.handle,{url:'/api/workspace/save',method:'POST',body:workspace()});secureError(r,409,'PRIVATE_COMMIT_UNKNOWN');assert.equal(r.body.requestId,workspace().requestId);assert.equal(r.body.queryOriginalRequest,true);
});
test('backend expiry is rechecked on every state read and no successful state is cached by the façade',async()=>{
 let at=NOW;const f=fixture({workspaceState:req=>{if(req.headers.cookie!=='fixture-session=verified'||at>=NOW+1000)throw failure('AUTH_REQUIRED');return workspaceState();}});
 const headers={cookie:'fixture-session=verified'};assert.equal((await invoke(f.handle,{headers})).status,200);at+=1000;secureError(await invoke(f.handle,{headers}),401,'AUTH_REQUIRED');assert.equal(f.calls.length,2);
});
test('a read transport failure never invents a pending mutation or a request ID to recover',async()=>{
 const f=fixture({workspaceState:()=>{throw failure('PRIVATE_COMMIT_UNKNOWN',true);}}),r=await invoke(f.handle);secureError(r,503,'PRIVATE_UNAVAILABLE');assert.equal(r.body.queryOriginalRequest,undefined);assert.equal(r.body.requestId,undefined);
});
