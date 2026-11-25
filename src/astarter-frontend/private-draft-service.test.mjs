import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {createPrivateDraftService} from './private-draft-service.mjs';

const bytes=readFileSync(new URL('./private-draft-contract-fixtures.json',import.meta.url)),wire=JSON.parse(bytes);
const HOST='astarter.imstark.site',ORIGIN='https://'+HOST,OWNER='wallet:56:0x'+'a'.repeat(40),REQUEST='draft-adopt-01',TOKEN='b'.repeat(64),NOW=wire.source.createdAt+1000;
const copy=value=>structuredClone(value),previewInput=(kind='previewGrid')=>copy(wire[kind]);
const adoptInput=(kind='previewGrid')=>({...previewInput(kind),requestId:REQUEST,expectedRevision:0,workspaceRevision:2,proposalRevision:TOKEN});
function content(kind='previewGrid'){
 const fields=previewInput(kind).fields,missing=Object.entries(fields).filter(([,value])=>value===null).map(([key])=>key);
 return {catalogVersion:'private-paper-draft-v1',templateVersion:fields.planVariant+'@paper-v1',parameterOrigin:'user-confirmed',source:copy(wire.source),fields,missingFields:missing.sort(),executionAuthority:'NONE'};
}
const document=(kind='previewGrid')=>({schema:'private-strategy-draft-v1',scope:OWNER,draftId:'draft-01',revision:1,savedAt:NOW,content:content(kind)});
const preview=(kind='previewGrid')=>({schema:'private-draft-preview-v1',scope:OWNER,draftId:'draft-01',expectedRevision:0,workspaceRevision:2,proposalRevision:TOKEN,listed:false,current:null,proposal:content(kind),changedFields:copy(wire.changedFieldsOrder)});
const command=(kind='previewGrid')=>({schema:'private-draft-command-v1',scope:OWNER,request:{requestId:REQUEST,draftId:'draft-01',status:'applied',expectedRevision:0,revision:1,workspaceBaseRevision:2,workspaceRevision:3,appliedAt:NOW},draft:document(kind)});
const failure=(code,outcomeUnknown)=>Object.assign(Error('offline-private-error-detail'),{code,...(outcomeUnknown===undefined?{}:{outcomeUnknown})});
function fixture(overrides={}){
 const calls=[],defaults={draftsPreview:()=>preview(),draftsGet:()=>document(),draftsAdopt:()=>command(),draftsRequest:()=>null};
 const backend=Object.fromEntries(Object.entries({...defaults,...overrides}).map(([method,run])=>[method,async(req,input)=>{calls.push({method,req,input:copy(input)});return run(req,input);} ]));
 return {calls,backend,handle:createPrivateDraftService({backend})};
}
async function invoke(handle,{url='/api/strategy-drafts/get?draftId=draft-01',method='GET',body,raw,headers={},parsed}={}){
 const data=raw!==undefined?Buffer.from(raw):body!==undefined?Buffer.from(JSON.stringify(body)):Buffer.alloc(0);
 const req=Object.assign(Readable.from(data.length?[data]:[]),{url,method,headers:{host:HOST,...(method==='POST'?{origin:ORIGIN,'content-type':'application/json','content-length':String(data.length)}:{}),...headers}});
 if(parsed!==undefined)req.body=parsed;
 let status,result,responseHeaders;const handled=await handle(req,{writeHead(value,h){status=value;responseHeaders=h;},end(value){result=JSON.parse(value);}});
 return {handled,status,body:result,headers:responseHeaders,req};
}
function secureError(value,status,code){
 assert.equal(value.status,status);assert.equal(value.body.error,code);assert.equal(value.body.executionAuthority,'NONE');
 assert.equal(value.headers['Cache-Control'],'no-store');assert.equal(value.headers['X-Content-Type-Options'],'nosniff');
 assert.doesNotMatch(JSON.stringify(value.body),/offline-private-error-detail|postgres-private|provider-private|fixture-credential/);
}
const post=(body=adoptInput(),patch={})=>({url:'/api/strategy-drafts/adopt',method:'POST',body,...patch});

test('the shared b682 fixture remains the only synthetic contract source and construction is inert',async()=>{
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'b682a71bdcb41635db6002441300010b8e44bdc1ae3dc407abc266f9384def03');assert.equal(wire.evidenceGrade,'SYNTHETIC_WIRE_ONLY');
 const f=fixture();assert.equal(f.calls.length,0);assert.equal((await invoke(f.handle,{url:'/unrelated'})).handled,false);assert.equal(f.calls.length,0);
 secureError(await invoke(createPrivateDraftService()),503,'PRIVATE_UNCONFIGURED');
 const partial={...f.backend};delete partial.draftsRequest;secureError(await invoke(createPrivateDraftService({backend:partial})),503,'PRIVATE_UNCONFIGURED');assert.equal(f.calls.length,0);
});

test('host, exact canonical Origin and cross-site checks run before preview/read/adopt dispatch',async()=>{
 const f=fixture();
 for(const headers of [{host:'attacker.test'},{host:HOST+':443'},{host:HOST+'.attacker.test'},{origin:'https://attacker.test'},{origin:ORIGIN+'/'},{'sec-fetch-site':'cross-site'}]){
  secureError(await invoke(f.handle,{headers}),403,'ORIGIN_DENIED');secureError(await invoke(f.handle,post(adoptInput(),{headers})),403,'ORIGIN_DENIED');
 }
 secureError(await invoke(f.handle,post(adoptInput(),{headers:{origin:undefined}})),403,'ORIGIN_DENIED');assert.equal(f.calls.length,0);
});

test('the four canonical routes reject wrong methods, extra query parameters, duplicate keys and fragments',async()=>{
 const f=fixture();
 for(const [url,method]of [['/api/strategy-drafts/preview','GET'],['/api/strategy-drafts/adopt','GET'],['/api/strategy-drafts/get?draftId=draft-01','POST'],['/api/strategy-drafts/request?requestId='+REQUEST,'POST'],['/api/strategy-drafts/get?draftId=draft-01','DELETE']])secureError(await invoke(f.handle,{url,method,body:{}}),405,'METHOD_NOT_ALLOWED');
 for(const url of ['/api/strategy-drafts/unknown','/api/strategy-drafts/get','/api/strategy-drafts/get?draftId=','/api/strategy-drafts/get?draftId=draft-01&draftId=draft-02','/api/strategy-drafts/get?draftId=draft-01&%64raftId=draft-02','/api/strategy-drafts/get?draftId=draft-01&ownerRef=other','/api/strategy-drafts/get?draftId=draft-01#fragment','/api/strategy-drafts/request','/api/strategy-drafts/request?requestId=short','/api/strategy-drafts/request?requestId='+REQUEST+'&requestId='+REQUEST,'/api/strategy-drafts/request?requestId='+REQUEST+'&%72equestId='+REQUEST,'/api/strategy-drafts/request?requestId='+REQUEST+'&draftId=draft-01'])secureError(await invoke(f.handle,{url}),400,'PRIVATE_REQUEST_INVALID');
 for(const url of ['/api/strategy-drafts/adopt?x=1','/api/strategy-drafts/preview?x=1'])secureError(await invoke(f.handle,{url,method:'POST',body:url.includes('preview')?previewInput():adoptInput()}),400,'PRIVATE_REQUEST_INVALID');assert.equal(f.calls.length,0);
});

test('GET bodies and every caller identity header are rejected without trusting browser ownership',async()=>{
 const f=fixture();
 for(const headers of [{'content-length':'1'},{'transfer-encoding':'chunked'},{'x-workspace-id':'other'},{'x-user-id':'other'},{'x-owner-ref':OWNER},{'x-tenant-id':'other'},{'x-scope-id':'other'},{'x-subject-id':'other'}]){
  secureError(await invoke(f.handle,{headers}),400,'PRIVATE_REQUEST_INVALID');
  if(Object.keys(headers)[0].startsWith('x-'))secureError(await invoke(f.handle,post(adoptInput(),{headers})),400,'PRIVATE_REQUEST_INVALID');
 }
 assert.equal(f.calls.length,0);
});

test('strict JSON MIME, UTF8, content length and the 16384-byte wire ceiling precede backend calls',async()=>{
 const f=fixture();secureError(await invoke(f.handle,post(adoptInput(),{headers:{'content-type':'text/plain'}})),415,'JSON_REQUIRED');
 for(const raw of ['{','[]','null',Buffer.from([0xc3,0x28])])secureError(await invoke(f.handle,{url:'/api/strategy-drafts/adopt',method:'POST',raw}),400,'PRIVATE_REQUEST_INVALID');
 secureError(await invoke(f.handle,post(adoptInput(),{headers:{'content-length':'999999'}})),413,'BODY_TOO_LARGE');
 secureError(await invoke(f.handle,post(adoptInput(),{headers:{'content-length':'1'}})),400,'PRIVATE_REQUEST_INVALID');
 secureError(await invoke(f.handle,{url:'/api/strategy-drafts/preview',method:'POST',raw:' '.repeat(16385)}),413,'BODY_TOO_LARGE');assert.equal(f.calls.length,0);
 const raw=JSON.stringify(previewInput()),padded=raw+' '.repeat(16384-Buffer.byteLength(raw));const exact=await invoke(f.handle,{url:'/api/strategy-drafts/preview',method:'POST',raw:padded});assert.equal(exact.status,200);assert.equal(f.calls.length,1);
 const parsed=adoptInput();const saved=await invoke(f.handle,post(undefined,{parsed,headers:{'content-length':undefined}}));assert.equal(saved.status,200);assert.deepEqual(f.calls.at(-1).input,parsed);
 const oversized={...adoptInput(),extra:'x'.repeat(16384)};secureError(await invoke(f.handle,post(undefined,{parsed:oversized,headers:{'content-length':undefined}})),413,'BODY_TOO_LARGE');
});

test('prototype changes, JSON prototype keys and accessors are rejected without executing getters',async()=>{
 const f=fixture();const inherited=Object.assign(Object.create({inherited:'not-input'}),adoptInput());secureError(await invoke(f.handle,post(undefined,{parsed:inherited})),400,'PRIVATE_REQUEST_INVALID');
 const nested=adoptInput();nested.fields=Object.assign(Object.create(null),nested.fields);secureError(await invoke(f.handle,post(undefined,{parsed:nested})),400,'PRIVATE_REQUEST_INVALID');
 let getters=0;const accessor=adoptInput();Object.defineProperty(accessor,'fields',{enumerable:true,get(){getters++;throw Error('fixture-credential');}});secureError(await invoke(f.handle,post(undefined,{parsed:accessor})),400,'PRIVATE_REQUEST_INVALID');assert.equal(getters,0);
 const nestedGetter=adoptInput();Object.defineProperty(nestedGetter.fields,'amount',{enumerable:true,get(){getters++;return 20;}});secureError(await invoke(f.handle,post(undefined,{parsed:nestedGetter})),400,'PRIVATE_REQUEST_INVALID');assert.equal(getters,0);
 const raw=JSON.stringify(adoptInput()).replace('"fields":{','"fields":{"__proto__":{},');secureError(await invoke(f.handle,{url:'/api/strategy-drafts/adopt',method:'POST',raw}),400,'PRIVATE_REQUEST_INVALID');assert.equal(f.calls.length,0);
});

test('inputs contain only immutable draft/source references, nullable user fields and adopt CAS metadata',async()=>{
 const f=fixture();
 for(const extra of [{ownerRef:OWNER},{source:wire.source},{executionAuthority:'NONE'},{token:'fixture-credential'},{approved:true},{sourceJobId:'invented-job'}])for(const kind of ['preview','adopt']){
  const input={...(kind==='preview'?previewInput():adoptInput()),...extra};secureError(await invoke(f.handle,{url:'/api/strategy-drafts/'+kind,method:'POST',body:input}),400,'PRIVATE_REQUEST_INVALID');
 }
 for(const input of [{...adoptInput(),requestId:'short'},{...adoptInput(),expectedRevision:-1},{...adoptInput(),workspaceRevision:.5},{...adoptInput(),proposalRevision:'not-a-digest'}])secureError(await invoke(f.handle,post(input)),400,'PRIVATE_REQUEST_INVALID');
 const added=adoptInput();added.fields.botParameters.foo='extra';secureError(await invoke(f.handle,post(added)),400,'PRIVATE_REQUEST_INVALID');assert.equal(f.calls.length,0);
});

for(const kind of ['previewEmpty','previewGrid','previewBasket'])test('canonical '+kind+' preview and adoption pass exact private-only fields without creating execution',async()=>{
 const f=fixture({draftsPreview:()=>preview(kind),draftsAdopt:()=>command(kind)}),input=previewInput(kind),adoption=adoptInput(kind),before=copy(adoption);
 const p=await invoke(f.handle,{url:'/api/strategy-drafts/preview',method:'POST',body:input});assert.equal(p.status,200);assert.deepEqual(p.body,preview(kind));assert.deepEqual(f.calls[0].input,input);assert.equal(p.body.proposal.executionAuthority,'NONE');
 const a=await invoke(f.handle,post(adoption));assert.equal(a.status,200);assert.deepEqual(a.body,command(kind));assert.deepEqual(f.calls[1].input,before);assert.deepEqual(adoption,before);
 assert.equal(a.body.draft.content.executionAuthority,'NONE');assert.equal(a.body.authorization,undefined);assert.equal(a.body.run,undefined);assert.equal(a.body.draft.content.parameterOrigin,'user-confirmed');
 if(kind==='previewEmpty'){assert.equal(a.body.draft.content.fields.amount,null);assert.ok(a.body.draft.content.missingFields.includes('amount'));}
});

test('existing-draft preview preserves old user fields and returns ordered differences without saving',async()=>{
 const value=preview();value.current=document();value.expectedRevision=1;value.listed=true;value.proposal.fields.name='User-confirmed updated name';value.changedFields=['fields.name'];
 const input=previewInput();input.fields.name=value.proposal.fields.name;
 const f=fixture({draftsPreview:()=>value});const r=await invoke(f.handle,{url:'/api/strategy-drafts/preview',method:'POST',body:input});assert.equal(r.status,200);assert.equal(r.body.current.content.fields.name,'BTC research draft');assert.equal(r.body.proposal.fields.name,input.fields.name);assert.deepEqual(r.body.changedFields,['fields.name']);assert.deepEqual(f.calls.map(x=>x.method),['draftsPreview']);
});

test('preview rejects a valid but different target, source, fields or invalid difference projection',async()=>{
 for(const patch of [v=>{v.draftId='other-draft';},v=>{v.proposal.source.sourceRequestId='other-research-01';},v=>{v.proposal.fields.name='Different proposal';},v=>{v.changedFields=[];}]){
  const result=preview();patch(result);const f=fixture({draftsPreview:()=>result});secureError(await invoke(f.handle,{url:'/api/strategy-drafts/preview',method:'POST',body:previewInput()}),503,'PRIVATE_UI_PROTOCOL');assert.equal(f.calls.length,1);
 }
});

test('GET reads return the exact private draft or null and reject another valid draft ID',async()=>{
 const f=fixture();const r=await invoke(f.handle);assert.equal(r.status,200);assert.deepEqual(r.body,document());assert.deepEqual(f.calls[0].input,{draftId:'draft-01'});assert.equal(f.calls[0].req,r.req);
 const absent=fixture({draftsGet:()=>null});const n=await invoke(absent.handle);assert.equal(n.status,200);assert.equal(n.body,null);
 const wrong=document();wrong.draftId='another-draft';secureError(await invoke(fixture({draftsGet:()=>wrong}).handle),503,'PRIVATE_UI_PROTOCOL');
});

test('adoption receipt and original request lookup carry the exact request and draft without a second adoption',async()=>{
 let saved=null;const f=fixture({draftsAdopt:(_req,input)=>{assert.equal(input.requestId,REQUEST);saved=command();return saved;},draftsRequest:(_req,input)=>input.requestId===REQUEST?saved:null});
 const r=await invoke(f.handle,post());assert.equal(r.status,200);const q=await invoke(f.handle,{url:'/api/strategy-drafts/request?requestId='+REQUEST});assert.equal(q.status,200);assert.deepEqual(q.body,r.body);assert.deepEqual(f.calls.map(c=>c.method),['draftsAdopt','draftsRequest']);assert.deepEqual(f.calls[1].input,{requestId:REQUEST});
 const wrong=command();wrong.request.requestId='other-adopt-01';secureError(await invoke(fixture({draftsRequest:()=>wrong}).handle,{url:'/api/strategy-drafts/request?requestId='+REQUEST}),503,'PRIVATE_UI_PROTOCOL');
});

test('every mismatched valid adopt receipt becomes COMMIT_UNKNOWN with original ID, never a successful substitute',async()=>{
 const changes=[v=>{v.request.requestId='other-adopt-01';},v=>{v.request.draftId=v.draft.draftId='other-draft';},v=>{v.request.expectedRevision=1;v.request.revision=v.draft.revision=2;},v=>{v.request.workspaceBaseRevision=3;v.request.workspaceRevision=4;},v=>{v.draft.content.source.sourceRequestId='other-research-01';},v=>{v.draft.content.fields.name='Another user edit';},v=>{v.draft.content.fields.amount=21;},v=>{v.draft.content.executionAuthority='APPROVED';}];
 for(const change of changes){const result=command();change(result);const f=fixture({draftsAdopt:()=>result});const r=await invoke(f.handle,post());secureError(r,409,'PRIVATE_COMMIT_UNKNOWN');assert.equal(r.body.requestId,REQUEST);assert.equal(r.body.queryOriginalRequest,true);assert.equal(r.body.draft,undefined);assert.equal(r.body.request,undefined);assert.equal(f.calls.length,1);}
});

test('network loss after dispatch preserves the original request ID and GET null cannot prove noncommit or trigger a POST',async()=>{
 const f=fixture({draftsAdopt:()=>{throw Error('provider-private network detail');},draftsRequest:()=>null});const r=await invoke(f.handle,post());secureError(r,409,'PRIVATE_COMMIT_UNKNOWN');assert.equal(r.body.requestId,REQUEST);assert.equal(r.body.queryOriginalRequest,true);
 for(let i=0;i<2;i++){const read=await invoke(f.handle,{url:'/api/strategy-drafts/request?requestId='+REQUEST});assert.equal(read.status,200);assert.equal(read.body,null);assert.equal(read.body?.status,undefined);}
 assert.deepEqual(f.calls.map(c=>c.method),['draftsAdopt','draftsRequest','draftsRequest']);
});

test('committed-but-lost transport can recover the original receipt with GET and no replay',async()=>{
 let saved;const f=fixture({draftsAdopt:()=>{saved=command();throw failure('PRIVATE_COMMIT_UNKNOWN',true);},draftsRequest:()=>saved});
 const r=await invoke(f.handle,post());secureError(r,409,'PRIVATE_COMMIT_UNKNOWN');const q=await invoke(f.handle,{url:'/api/strategy-drafts/request?requestId='+REQUEST});assert.equal(q.status,200);assert.deepEqual(q.body,saved);assert.deepEqual(f.calls.map(c=>c.method),['draftsAdopt','draftsRequest']);
});

for(const [code,status]of [['PRIVATE_REQUEST_INVALID',400],['AUTH_REQUIRED',401],['PRIVATE_AUTH_REQUIRED',401],['PRIVATE_FORBIDDEN',403],['PRIVATE_TARGET_MISMATCH',403],['PRIVATE_CONFLICT',409],['PRIVATE_UNAVAILABLE',503]])test('known '+code+' remains sanitized and distinguishable from commit uncertainty',async()=>{
 const f=fixture({draftsAdopt:()=>{throw failure(code,false);},draftsGet:()=>{throw failure(code,false);}}),expected=code==='PRIVATE_AUTH_REQUIRED'?'AUTH_REQUIRED':code;
 for(const r of [await invoke(f.handle,post()),await invoke(f.handle)]){secureError(r,status,expected);assert.equal(r.body.queryOriginalRequest,undefined);assert.equal(r.body.request,undefined);}
 assert.equal(f.calls.length,2);
});

test('uncertain unavailable and protocol failures after dispatch stay unknown, while read/preview errors never fabricate receipts',async()=>{
 for(const cause of [failure('PRIVATE_UNAVAILABLE'),failure('PRIVATE_COMMIT_UNKNOWN'),failure('PRIVATE_UI_PROTOCOL'),failure('AUTH_REQUIRED',true)]){
  const f=fixture({draftsAdopt:()=>{throw cause;}});const r=await invoke(f.handle,post());secureError(r,409,'PRIVATE_COMMIT_UNKNOWN');assert.equal(r.body.requestId,REQUEST);assert.equal(f.calls.length,1);
 }
 const f=fixture({draftsGet:()=>{throw Error('postgres-private');},draftsPreview:()=>{throw Error('provider-private');}});secureError(await invoke(f.handle),503,'PRIVATE_UNAVAILABLE');secureError(await invoke(f.handle,{url:'/api/strategy-drafts/preview',method:'POST',body:previewInput()}),503,'PRIVATE_UNAVAILABLE');assert.equal(f.calls.filter(c=>c.method==='draftsAdopt').length,0);
});

test('native loopback HTTP streams exercise the actual parser and exact original receipt recovery with a fake backend',async t=>{
 let saved;const f=fixture({draftsAdopt:()=>{saved=command();throw Error('offline-private-error-detail');},draftsRequest:()=>saved});
 const server=createServer((req,res)=>{void f.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const exchange=(url,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{
  const raw=body===undefined?null:Buffer.from(JSON.stringify(body));const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,path:url,method,headers:{Host:HOST,...(method==='POST'?{Origin:ORIGIN,'Content-Type':'application/json','Content-Length':String(raw?.length||0)}:{}),...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8')),headers:res.headers});}catch(error){reject(error);}});});req.on('error',reject);req.end(raw);
 });
 const p=await exchange('/api/strategy-drafts/preview',{method:'POST',body:previewInput()});assert.equal(p.status,200);assert.deepEqual(p.body,preview());assert.equal(p.headers['cache-control'],'no-store');
 const a=await exchange('/api/strategy-drafts/adopt',{method:'POST',body:adoptInput()});assert.equal(a.status,409);assert.deepEqual(a.body,{error:'PRIVATE_COMMIT_UNKNOWN',requestId:REQUEST,queryOriginalRequest:true,executionAuthority:'NONE'});
 const q=await exchange('/api/strategy-drafts/request?requestId='+REQUEST);assert.equal(q.status,200);assert.deepEqual(q.body,saved);assert.deepEqual(f.calls.map(c=>c.method),['draftsPreview','draftsAdopt','draftsRequest']);
 const bad=await exchange('/api/strategy-drafts/get?draftId=draft-01&draftId=other');assert.equal(bad.status,400);assert.equal(bad.body.error,'PRIVATE_REQUEST_INVALID');assert.equal(f.calls.length,3);
});
