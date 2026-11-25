import test from 'node:test';
import assert from 'node:assert/strict';

test('private draft browser factory exists without constructing an authenticated session or sending HTTP',async()=>{
 const module=await import('./private-draft-client.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
 assert.equal(typeof module.createPrivateDraftClient,'function');
});

import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPrivateDraftClient} from './private-draft-client.mjs';
const fixtureBytes=readFileSync(new URL('./private-draft-contract-fixtures.json',import.meta.url)),wire=JSON.parse(fixtureBytes);
const OWNER='wallet:56:0x'+'a'.repeat(40),OTHER='wallet:56:0x'+'b'.repeat(40),NOW=wire.source.createdAt+1000,ID='adopt-browser-01',TOKEN='b'.repeat(64);
const copy=value=>structuredClone(value),input=(kind='previewGrid')=>copy(wire[kind]);
function content(kind='previewGrid'){const fields=input(kind).fields;return {catalogVersion:'private-paper-draft-v1',templateVersion:fields.planVariant+'@paper-v1',parameterOrigin:'user-confirmed',source:copy(wire.source),fields,missingFields:Object.entries(fields).filter(([,value])=>value===null).map(([key])=>key).sort(),executionAuthority:'NONE'};}
const document=(kind='previewGrid',scope=OWNER)=>({schema:'private-strategy-draft-v1',scope,draftId:'draft-01',revision:1,savedAt:NOW,content:content(kind)});
const preview=(kind='previewGrid',scope=OWNER)=>({schema:'private-draft-preview-v1',scope,draftId:'draft-01',expectedRevision:0,workspaceRevision:2,proposalRevision:TOKEN,listed:false,current:null,proposal:content(kind),changedFields:copy(wire.changedFieldsOrder)});
function command(body,kind='previewGrid',scope=OWNER){return {schema:'private-draft-command-v1',scope,request:{requestId:body.requestId,draftId:body.draftId,status:'applied',expectedRevision:body.expectedRevision,revision:body.expectedRevision+1,workspaceBaseRevision:body.workspaceRevision,workspaceRevision:body.workspaceRevision+1,appliedAt:NOW},draft:{...document(kind,scope),draftId:body.draftId,revision:body.expectedRevision+1}};}
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}),flush=()=>new Promise(resolve=>setImmediate(resolve));
function memory(){const entries=new Map();return {entries,getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,String(value))};}
function fixture(t,options={}){
 const calls=[],storage=options.storage===undefined?memory():options.storage,changes=[];let seq=0;
 const client=createPrivateDraftClient({storage,now:()=>NOW,makeRequestId:()=>ID+'-'+(++seq),fetchImpl:async(url,init)=>{calls.push({url,init});return response(url.endsWith('/preview')?preview():url.endsWith('/adopt')?command(JSON.parse(init.body)):url.includes('/request?')?null:document());},onChange:value=>changes.push(value),...options});
 t.after(()=>client.dispose());return {client,storage,calls,changes};
}
const assertIntent=(value,id)=>{assert.equal(value.requestId,id);assert.equal(value.canAdopt,false);assert.equal(value.executionAuthority,'NONE');};

test('pinned shared contract, bounded timeout and inert identity/render setup',async t=>{
 assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'),'b682a71bdcb41635db6002441300010b8e44bdc1ae3dc407abc266f9384def03');
 for(const timeoutMs of [0,-1,.5,15001,'10',Infinity])assert.throws(()=>createPrivateDraftClient({timeoutMs}),/PRIVATE_TIMEOUT_INVALID/);
 const {client,calls}=fixture(t);assert.equal(client.snapshot().status,'auth-required');client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});
 assert.equal(client.snapshot().status,'idle');assert.equal(client.snapshot().preview,null);assert.equal(client.snapshot().draft,null);assert.equal(calls.length,0);
 await assert.rejects(()=>client.adopt(),/PRIVATE_DRAFT_NOT_READY/);assert.equal(calls.length,0);
});

test('explicit get returns historical verified metadata or null without creating an adoption',async t=>{
 let reads=0;const {client}=fixture(t,{now:()=>wire.source.validUntil+1000,fetchImpl:async(url,init)=>{assert.equal(url,'/api/strategy-drafts/get?draftId=draft-01');assert.equal(init.method,'GET');reads++;return response(reads===1?document():null);}});
 client.setIdentity({ownerRef:OWNER,expiresAt:wire.source.validUntil+61000});await client.get('draft-01');assert.deepEqual(client.snapshot().draft,document());assert.equal(client.snapshot().canAdopt,false);await client.get('draft-01');assert.equal(client.snapshot().draft,null);assert.equal(reads,2);
});

for(const kind of ['previewEmpty','previewGrid','previewBasket'])test(kind+' stays nullable and user-owned from verified preview through exact adoption',async t=>{
 const calls=[];const {client}=fixture(t,{fetchImpl:async(url,init)=>{calls.push({url,init});return response(url.endsWith('/preview')?preview(kind):command(JSON.parse(init.body),kind));}});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});
 const value=input(kind);await client.preview(value);value.fields.name='Changed outside client';const viewed=client.snapshot();assert.equal(viewed.status,'preview');assert.equal(viewed.canAdopt,true);viewed.preview.proposal.fields.name='Changed detached snapshot';
 await client.adopt();assert.equal(client.snapshot().status,'ready');assert.equal(client.snapshot().requestId,null);assert.equal(client.snapshot().preview,null);assert.deepEqual(client.snapshot().draft,document(kind));
 const canonical=JSON.parse(calls[1].init.body);assert.deepEqual(canonical,{...input(kind),requestId:ID+'-1',expectedRevision:0,workspaceRevision:2,proposalRevision:TOKEN});
 assert.equal(calls[0].url,'/api/strategy-drafts/preview');assert.deepEqual(JSON.parse(calls[0].init.body),input(kind));assert.equal(calls[1].url,'/api/strategy-drafts/adopt');
 for(const {init}of calls){assert.equal(init.method,'POST');assert.equal(init.credentials,'same-origin');assert.equal(init.cache,'no-store');assert.equal(init.redirect,'error');assert.deepEqual(Object.keys(init.headers).sort(),['Accept','Content-Type']);}
 assert.equal(client.snapshot().draft.content.executionAuthority,'NONE');assert.equal(client.snapshot().authorization,undefined);
 if(kind==='previewEmpty'){assert.equal(canonical.fields.amount,null);assert.equal(client.snapshot().draft.content.fields.cap,null);}
});

test('canonical pending intent is durably round-trip checked before adoption dispatch and double-clicks share one POST',async t=>{
 let release,posted=0;const hold=new Promise(resolve=>{release=resolve;}),storage=memory();
 const {client}=fixture(t,{storage,fetchImpl:async(url,init)=>{if(url.endsWith('/preview'))return response(preview());posted++;const body=JSON.parse(init.body),saved=JSON.parse([...storage.entries.values()][0]);assert.deepEqual(saved.intent.input,body);assert.equal(saved.ownerRef,OWNER);assert.equal(saved.intent.preview.proposalRevision,TOKEN);await hold;return response(command(body));}});
 client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.preview(input());const one=client.adopt(),two=client.adopt();await flush();assert.equal(posted,1);assert.equal(client.snapshot().status,'adopting');release();await Promise.all([one,two]);assert.equal(posted,1);assert.equal(client.snapshot().requestId,null);
});

test('lost ACK survives disposal/reload; original GET null stays unknown and never creates another adoption',async t=>{
 const storage=memory(),calls=[];let saved,confirmed=false;
 const fetchImpl=async(url,init)=>{calls.push({url,init});if(url.endsWith('/preview'))return response(preview());if(url.endsWith('/adopt')){saved=command(JSON.parse(init.body));throw Error('offline private provider detail');}return response(confirmed?saved:null);};
 const first=fixture(t,{storage,fetchImpl}).client;first.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await first.preview(input());await first.adopt();assert.equal(first.snapshot().status,'unknown');const id=first.snapshot().requestId;first.dispose();
 const next=fixture(t,{storage,fetchImpl}).client;next.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});assert.equal(next.snapshot().status,'unknown');assert.equal(next.snapshot().preview,null);assert.equal(next.snapshot().draft,null);assertIntent(next.snapshot(),id);
 for(let i=0;i<2;i++){await next.query();assert.equal(next.snapshot().status,'unknown');assert.equal(next.snapshot().error,'PRIVATE_ORIGINAL_REQUEST_NOT_FOUND');assertIntent(next.snapshot(),id);}
 await assert.rejects(()=>next.adopt(),/PRIVATE_ORIGINAL_REQUEST_PENDING/);await assert.rejects(()=>next.preview(input()),/PRIVATE_ORIGINAL_REQUEST_PENDING/);await assert.rejects(()=>next.get('other-draft'),/PRIVATE_ORIGINAL_REQUEST_PENDING/);
 confirmed=true;await next.query();assert.equal(next.snapshot().status,'ready');assert.equal(next.snapshot().draft.draftId,'draft-01');assert.equal(next.snapshot().requestId,null);
 assert.equal(calls.filter(x=>x.url.endsWith('/adopt')).length,1);assert.deepEqual(calls.slice(2).map(x=>[x.init.method,x.url]),Array.from({length:3},()=>['GET','/api/strategy-drafts/request?requestId='+id]));
});

test('invalidate drops old preview and does not discard an in-flight original adoption intent',async t=>{
 let release,body;const hold=new Promise(resolve=>{release=resolve;});const {client}=fixture(t,{fetchImpl:async(url,init)=>{if(url.endsWith('/preview'))return response(preview());body=JSON.parse(init.body);await hold;return response(command(body));}});
 client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.preview(input());client.invalidate();assert.equal(client.snapshot().canAdopt,false);await assert.rejects(()=>client.adopt(),/PRIVATE_DRAFT_NOT_READY/);
 await client.preview(input());const pending=client.adopt();await flush();const id=client.snapshot().requestId;client.invalidate();assert.equal(client.snapshot().status,'adopting');assertIntent(client.snapshot(),id);release();await pending;assert.equal(client.snapshot().draft.revision,1);assert.equal(client.snapshot().requestId,null);
});

test('owner switches abort old work, hide old fields and restore only that owner original ID',async t=>{
 const storage=memory();let release,oldBody;const hold=new Promise(resolve=>{release=resolve;});const calls=[];
 const {client}=fixture(t,{storage,fetchImpl:async(url,init)=>{calls.push({url,init});if(url.endsWith('/preview'))return response(preview());if(url.endsWith('/adopt')){oldBody=JSON.parse(init.body);await hold;return response(command(oldBody));}return response(command(oldBody));}});
 client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.preview(input());const pending=client.adopt();await flush();const id=client.snapshot().requestId,oldSignal=calls.at(-1).init.signal;
 client.setIdentity({ownerRef:OTHER,expiresAt:NOW+60000});assert.equal(oldSignal.aborted,true);assert.equal(client.snapshot().ownerRef,OTHER);assert.equal(client.snapshot().requestId,null);assert.equal(client.snapshot().draft,null);assert.equal(client.snapshot().localInput,null);release();await pending;assert.equal(client.snapshot().draft,null);
 const count=calls.length;client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});assert.equal(calls.length,count);assertIntent(client.snapshot(),id);await client.query();assert.equal(client.snapshot().draft.scope,OWNER);assert.equal(calls.filter(x=>x.url.endsWith('/adopt')).length,1);
});

test('late preview and disposed adoption replies cannot republish old private data',async t=>{
 let release;const hold=new Promise(resolve=>{release=resolve;}),changes=[];const {client}=fixture(t,{onChange:v=>changes.push(v),fetchImpl:async()=>{await hold;return response(preview());}});
 client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});const pending=client.preview(input());await flush();client.setIdentity({ownerRef:OTHER,expiresAt:NOW+60000});const count=changes.length;release();await pending;assert.equal(client.snapshot().preview,null);assert.equal(client.snapshot().draft,null);assert.equal(changes.length,count);
 let finish,body;const wait=new Promise(resolve=>{finish=resolve;}),signals=[];const next=fixture(t,{fetchImpl:async(url,init)=>{signals.push(init.signal);if(url.endsWith('/preview'))return response(preview());body=JSON.parse(init.body);await wait;return response(command(body));}}).client;
 next.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await next.preview(input());const adoption=next.adopt();await flush();next.dispose();finish();await adoption;assert.equal(signals.at(-1).aborted,true);assert.equal(next.snapshot().draft,null);assert.equal(next.snapshot().preview,null);assert.equal(next.snapshot().canQuery,false);
});

test('natural identity expiry aborts pending HTTP and clears display without losing its recoverable original intent',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=NOW;const storage=memory(),calls=[];
 const {client}=fixture(t,{storage,now:()=>now,fetchImpl:async(url,init)=>{calls.push({url,init});if(url.endsWith('/preview'))return response(preview());return new Promise(()=>{});}});
 client.setIdentity({ownerRef:OWNER,expiresAt:NOW+100});await client.preview(input());const adoption=client.adopt();await flush();const id=client.snapshot().requestId;now+=100;t.mock.timers.tick(100);await adoption;
 assert.equal(client.snapshot().status,'auth-required');assert.equal(client.snapshot().draft,null);assert.equal(client.snapshot().preview,null);assert.equal(client.snapshot().localInput,null);assertIntent(client.snapshot(),id);assert.equal(calls.at(-1).init.signal.aborted,true);
 client.setIdentity({ownerRef:OWNER,expiresAt:now+60000});assert.equal(client.snapshot().status,'unknown');assertIntent(client.snapshot(),id);assert.equal(calls.length,2);
 client.dispose();const count=calls.length;t.mock.timers.tick(60000);assert.equal(calls.length,count);
});

test('natural proposal expiry disables adoption without an automatic POST or identity loss',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=wire.source.validUntil-10;const {client,calls}=fixture(t,{now:()=>now});client.setIdentity({ownerRef:OWNER,expiresAt:now+60000});await client.preview(input());assert.equal(client.snapshot().canAdopt,true);now+=10;t.mock.timers.tick(10);assert.equal(client.snapshot().preview,null);assert.equal(client.snapshot().canAdopt,false);assert.equal(client.snapshot().ownerRef,OWNER);assert.equal(client.snapshot().error,'PRIVATE_DRAFT_PREVIEW_EXPIRED');assert.equal(calls.length,1);
});

for(const brokenStorage of [null,{getItem:()=>null,setItem(){throw Error('offline storage blocked');}},{getItem:()=>null,setItem(){}}])test('unconfirmed pending persistence prevents adoption POST: '+(brokenStorage===null?'missing':'write failure'),async t=>{
 let adoptions=0;const {client}=fixture(t,{storage:brokenStorage,fetchImpl:async url=>{if(url.endsWith('/adopt'))adoptions++;return response(preview());}});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.preview(input());await client.adopt();assert.equal(adoptions,0);assert.equal(client.snapshot().status,'error');assert.equal(client.snapshot().error,'PRIVATE_STORAGE_UNAVAILABLE');assert.equal(client.snapshot().canAdopt,false);
});

test('owner-scoped cache cannot transplant another owner, altered fields or a cached preview into server authority',async t=>{
 const storage=memory();const first=fixture(t,{storage,fetchImpl:async url=>{if(url.endsWith('/preview'))return response(preview());throw Error('offline unknown');}}).client;first.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await first.preview(input());await first.adopt();const [key,text]=[...storage.entries][0];first.dispose();
 const otherKey=key.replace(encodeURIComponent(OWNER),encodeURIComponent(OTHER));storage.entries.set(otherKey,text);const reads=[];const get=storage.getItem;storage.getItem=k=>{reads.push(k);return get(k);};const {client,calls}=fixture(t,{storage});client.setIdentity({ownerRef:OTHER,expiresAt:NOW+60000});assert.equal(client.snapshot().status,'error');assert.equal(client.snapshot().error,'PRIVATE_LOCAL_STATE_INVALID');assert.equal(client.snapshot().canAdopt,false);assert.deepEqual(reads,[otherKey]);assert.equal(calls.length,0);
 const saved=JSON.parse(text);saved.intent.input.fields.name='Altered after approval';storage.entries.set(key,JSON.stringify(saved));client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});assert.equal(client.snapshot().status,'error');assert.equal(client.snapshot().canAdopt,false);assert.equal(client.snapshot().preview,null);assert.equal(calls.length,0);
});

for(const [status,error,expected]of [[409,'PRIVATE_CONFLICT','conflict'],[400,'PRIVATE_REQUEST_INVALID','error']])test('confirmed '+error+' keeps user input but requires a new explicit preview',async t=>{
 const {client,calls}=fixture(t,{fetchImpl:async url=>response(url.endsWith('/preview')?preview():{error,executionAuthority:'NONE'},url.endsWith('/preview')?200:status)});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.preview(input());await client.adopt();assert.equal(client.snapshot().status,expected);assert.equal(client.snapshot().requestId,null);assert.deepEqual(client.snapshot().localInput,input());assert.equal(client.snapshot().preview,null);assert.equal(client.snapshot().canAdopt,false);await assert.rejects(()=>client.adopt(),/PRIVATE_DRAFT_NOT_READY/);
});

for(const status of [401,403])test('HTTP '+status+' retains original intent for same-owner reauthentication and queries',async t=>{
 let saved;const calls=[];const {client}=fixture(t,{fetchImpl:async(url,init)=>{calls.push({url,init});if(url.endsWith('/preview'))return response(preview());if(url.endsWith('/adopt')){saved=command(JSON.parse(init.body));return response({error:'AUTH_REQUIRED',executionAuthority:'NONE'},status);}return response(saved);}});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.preview(input());await client.adopt();const id=client.snapshot().requestId;assert.equal(client.snapshot().status,status===401?'auth-required':'forbidden');assert.equal(client.snapshot().draft,null);assertIntent(client.snapshot(),id);client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});assert.equal(calls.length,2);await client.query();assert.equal(client.snapshot().status,'ready');assert.equal(calls.at(-1).init.method,'GET');assert.equal(calls.filter(x=>x.url.endsWith('/adopt')).length,1);
});

test('wrong owner, immutable ID/CAS, source revision and user-field receipts stay unknown under their original ID',async t=>{
 const patches=[v=>{v.scope=v.draft.scope=OTHER;},v=>{v.request.requestId='other-request-01';},v=>{v.request.draftId=v.draft.draftId='another-draft';},v=>{v.request.expectedRevision++;v.request.revision++;v.draft.revision++;},v=>{v.request.workspaceBaseRevision++;v.request.workspaceRevision++;},v=>{v.draft.content.source.reportRevision='f'.repeat(64);},v=>{v.draft.content.source.evidenceRevision='e'.repeat(64);},v=>{v.draft.content.fields.name='Different user fields';},v=>{v.draft.content.executionAuthority='APPROVED';}];
 for(const patch of patches){const {client}=fixture(t,{fetchImpl:async(url,init)=>{if(url.endsWith('/preview'))return response(preview());const value=command(JSON.parse(init.body));patch(value);return response(value);}});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.preview(input());await client.adopt();assert.equal(client.snapshot().status,'unknown');assert.equal(client.snapshot().error,'PRIVATE_UI_PROTOCOL');assertIntent(client.snapshot(),ID+'-1');assert.equal(client.snapshot().draft,null);}
});

test('preview and get reject wrong target, owner or input without silently applying backend replacement fields',async t=>{
 for(const patch of [v=>{v.scope=OTHER;},v=>{v.draftId='other-draft';},v=>{v.proposal.source.sourceRequestId='other-source-01';},v=>{v.proposal.fields.name='Different proposal';}]){const value=preview();patch(value);const {client}=fixture(t,{fetchImpl:async()=>response(value)});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.preview(input());assert.equal(client.snapshot().preview,null);assert.equal(client.snapshot().canAdopt,false);assert.equal(client.snapshot().error,'PRIVATE_UI_PROTOCOL');}
 const d=document();d.draftId='other-draft';const {client}=fixture(t,{fetchImpl:async()=>response(d)});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.get('draft-01');assert.equal(client.snapshot().draft,null);assert.equal(client.snapshot().error,'PRIVATE_UI_PROTOCOL');
});

for(const hang of ['fetch','body'])test('shared deadline releases '+hang+' that ignores abort, retaining the same adoption ID',async t=>{
 let release,bodyCancelled=0;const late=new Promise(resolve=>{release=resolve;});const {client}=fixture(t,{timeoutMs:10,fetchImpl:async url=>{
  if(url.endsWith('/preview'))return response(preview());
  if(hang==='fetch')return late;
  return {status:200,headers:new Headers({'Content-Type':'application/json'}),body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:()=>{bodyCancelled++;return new Promise(()=>{});},releaseLock(){}})}};
 }});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.preview(input());const result=await client.adopt();assert.equal(result.status,'unknown');assert.equal(result.error,'PRIVATE_REQUEST_TIMEOUT');assertIntent(result,ID+'-1');assert.equal(result.canQuery,true);
 release({body:{cancel(){bodyCancelled++;}}});await flush();assert.ok(bodyCancelled>=1);assert.equal(client.snapshot().status,'unknown');assert.equal(client.snapshot().draft,null);
});

test('late transport rejection remains observed and does not turn an unknown request into another POST',async t=>{
 let rejectLate,adoptions=0;const late=new Promise((_,reject)=>{rejectLate=reject;});const {client}=fixture(t,{timeoutMs:5,fetchImpl:async url=>{if(url.endsWith('/preview'))return response(preview());adoptions++;return late;}});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.preview(input());await client.adopt();rejectLate(Error('offline secret detail'));await flush();assert.equal(client.snapshot().status,'unknown');assert.equal(adoptions,1);assert.doesNotMatch(client.snapshot().error,/secret|detail/);
});

test('response redirect, invalid UTF8/MIME and over-64KiB bodies fail closed without losing an adopt intent',async t=>{
 const invalid=[()=>new Response('x'.repeat(65537),{headers:{'Content-Type':'application/json'}}),()=>new Response(new Uint8Array([0xc3,0x28]),{headers:{'Content-Type':'application/json'}}),()=>new Response('{}',{headers:{'Content-Type':'text/html'}}),()=>({redirected:true,status:200,headers:new Headers({'Content-Type':'application/json'})})];
 for(const make of invalid){const {client}=fixture(t,{fetchImpl:async url=>url.endsWith('/preview')?response(preview()):make()});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.preview(input());await client.adopt();assert.equal(client.snapshot().status,'unknown');assert.equal(client.snapshot().canAdopt,false);assertIntent(client.snapshot(),ID+'-1');assert.equal(client.snapshot().draft,null);}
});

test('invalid source/authority/secret input is rejected before any preview POST or original query',async t=>{
 const {client,calls}=fixture(t);client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});
 for(const value of [{...input(),ownerRef:OWNER},{...input(),executionAuthority:'NONE'},{...input(),sourceJobId:'made-up'},{...input(),fields:{...input().fields,name:'sk-or-v1-'+'x'.repeat(30)}}])await assert.rejects(()=>client.preview(value),/PRIVATE_REQUEST_INVALID/);
 for(const id of ['bad/id','0x'+'a'.repeat(64),'sk-or-v1-'+'x'.repeat(30)])await assert.rejects(()=>client.get(id),/PRIVATE_REQUEST_INVALID/);
 await client.query();assert.equal(calls.length,0);
});

test('ambiguous conflicts or wrong original error IDs cannot clear an uncertain adoption intent',async t=>{
 for(const body of [{error:'PRIVATE_CONFLICT',executionAuthority:'NONE',queryOriginalRequest:true},{error:'PRIVATE_CONFLICT',executionAuthority:'NONE',queryOriginalRequest:'true'},{error:'PRIVATE_CONFLICT',executionAuthority:'NONE',requestId:'different-original-01'}]){
  const {client}=fixture(t,{fetchImpl:async url=>url.endsWith('/preview')?response(preview()):response(body,409)});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await client.preview(input());await client.adopt();assert.equal(client.snapshot().status,'unknown');assertIntent(client.snapshot(),ID+'-1');assert.equal(client.snapshot().canQuery,true);
 }
});

test('non-string persisted original IDs are invalid local metadata and never enable adoption',t=>{
 const storage=memory();storage.entries.set('astarter.private-drafts.v1:'+encodeURIComponent(OWNER),JSON.stringify({version:1,ownerRef:OWNER,intent:null,lastRequestId:12345678}));const {client,calls}=fixture(t,{storage});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});assert.equal(client.snapshot().status,'error');assert.equal(client.snapshot().error,'PRIVATE_LOCAL_STATE_INVALID');assert.equal(client.snapshot().canAdopt,false);assert.equal(calls.length,0);
});

test('editing invalidation aborts a pending preview and ignores its late result',async t=>{
 let release,signal;const hold=new Promise(resolve=>{release=resolve;});const {client}=fixture(t,{fetchImpl:async(_url,init)=>{signal=init.signal;await hold;return response(preview());}});client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});const pending=client.preview(input());await flush();client.invalidate();assert.equal(signal.aborted,true);release();await pending;assert.equal(client.snapshot().preview,null);assert.equal(client.snapshot().canAdopt,false);assert.equal(client.snapshot().status,'idle');
});
