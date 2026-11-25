import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validatePrivateDraftPreviewInput,validatePrivateDraftAdoptInput,validatePrivateDraftDocument,validatePrivateDraftPreview,validatePrivateDraftCommandResult} from './private-draft-data.mjs';

const fixtureBytes=readFileSync(new URL('./private-draft-contract-fixtures.json',import.meta.url)),fixture=JSON.parse(fixtureBytes);
const OWNER='wallet:56:0x'+'a'.repeat(40),OTHER='wallet:56:0x'+'b'.repeat(40),REQUEST='draft-adopt-01',TOKEN='b'.repeat(64),NOW=fixture.source.createdAt+1000;
const CHANGE_GROUPS=['source','fields.name','fields.strategy','fields.planVariant','fields.market','fields.environment','fields.mode','fields.amount','fields.cap','fields.researchBudget','fields.botParameters','fields.protection','fields.executionRoute'];
const copy=value=>structuredClone(value),fail=(run,code='PRIVATE_UI_PROTOCOL')=>assert.throws(run,error=>error.code===code&&error.message===code&&error.status===(code==='PRIVATE_REQUEST_INVALID'?400:502));
const previewInput=kind=>copy(fixture[kind||'previewGrid']);
const missing=fields=>{
 const result=Object.entries(fields).filter(([,value])=>value===null).map(([key])=>key);
 if(fields.botParameters){const required=fields.strategy==='S01'?['lower','upper','count','spacing']:['deviationPct','sizeMultiplier','maxEntries','takeProfitPct','stopLossPct'];if(fields.strategy==='S01'&&fields.protection?.id==='astarter')required.push('stopLossPrice');for(const key of required)if(fields.botParameters[key]===null)result.push('botParameters.'+key);}
 return result.sort();
};
function content(kind='previewGrid'){const fields=previewInput(kind).fields;return {catalogVersion:'private-paper-draft-v1',templateVersion:fields.planVariant+'@paper-v1',parameterOrigin:'user-confirmed',source:copy(fixture.source),fields,missingFields:missing(fields),executionAuthority:'NONE'};}
function document(kind='previewGrid'){return {schema:'private-strategy-draft-v1',scope:OWNER,draftId:'draft-01',revision:1,savedAt:NOW,content:content(kind)};}
function preview(kind='previewGrid'){return {schema:'private-draft-preview-v1',scope:OWNER,draftId:'draft-01',expectedRevision:0,workspaceRevision:2,proposalRevision:TOKEN,listed:false,current:null,proposal:content(kind),changedFields:[...CHANGE_GROUPS]};}
function adoptInput(kind='previewGrid'){return {...previewInput(kind),requestId:REQUEST,expectedRevision:0,workspaceRevision:2,proposalRevision:TOKEN};}
function command(kind='previewGrid'){return {schema:'private-draft-command-v1',scope:OWNER,request:{requestId:REQUEST,draftId:'draft-01',status:'applied',expectedRevision:0,revision:1,workspaceBaseRevision:2,workspaceRevision:3,appliedAt:NOW},draft:document(kind)};}

test('the pinned shared fixture is synthetic wire evidence and all nullable, S01 and S02 inputs remain exact independent copies',()=>{
 assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'),'b682a71bdcb41635db6002441300010b8e44bdc1ae3dc407abc266f9384def03');assert.equal(fixture.evidenceGrade,'SYNTHETIC_WIRE_ONLY');assert.deepEqual(fixture.changedFieldsOrder,CHANGE_GROUPS);assert.equal(fixture.schemas.DraftPreviewResult.properties.changedFields.maxItems,13);
 for(const kind of ['previewEmpty','previewGrid','previewBasket']){
  const value=previewInput(kind),result=validatePrivateDraftPreviewInput(value);assert.deepEqual(result,value);result.fields.name='Changed returned copy';assert.notEqual(value.fields.name,result.fields.name);
  assert.deepEqual(validatePrivateDraftAdoptInput(adoptInput(kind)),adoptInput(kind));
  assert.deepEqual(validatePrivateDraftDocument(document(kind),OWNER),document(kind));assert.deepEqual(validatePrivateDraftPreview(preview(kind),OWNER),preview(kind));assert.deepEqual(validatePrivateDraftCommandResult(command(kind),REQUEST,OWNER),command(kind));
 }
});

test('browser inputs never accept caller identity, source content, credentials, bindings or execution authority',()=>{
 for(const [key,value]of Object.entries({ownerRef:OTHER,scope:OTHER,tenantId:'other',subjectId:'other',leaseId:'lease',targetId:'target',audience:'astarter-research',source:fixture.source,executionAuthority:'NONE',token:'private',authorization:true}))for(const create of [previewInput,adoptInput]){
  const input=create();input[key]=value;fail(()=>create===previewInput?validatePrivateDraftPreviewInput(input):validatePrivateDraftAdoptInput(input),'PRIVATE_REQUEST_INVALID');
 }
 for(const path of ['fields','botParameters','protection','executionRoute']){const input=previewInput();const target=path==='fields'?input.fields:input.fields[path];target.apiKey='private';fail(()=>validatePrivateDraftPreviewInput(input),'PRIVATE_REQUEST_INVALID');}
 for(const name of ['Bearer '+'x'.repeat(24),'sk-or-v1-'+'x'.repeat(24),'https://user:password@example.test','0x'+'a'.repeat(64),'bad\nname']){const input=previewInput();input.fields.name=name;fail(()=>validatePrivateDraftPreviewInput(input),'PRIVATE_REQUEST_INVALID');}
});

test('all declared nullable fields are required keys and only S01/S02 DEMO auto paper variants are accepted',()=>{
 const input=previewInput('previewEmpty');assert.deepEqual(validatePrivateDraftPreviewInput(input),input);
 for(const key of Object.keys(input.fields)){const altered=copy(input);delete altered.fields[key];fail(()=>validatePrivateDraftPreviewInput(altered),'PRIVATE_REQUEST_INVALID');}
 for(const [key,value]of [['strategy','S03'],['strategy','Q08'],['planVariant','S02-SIM'],['environment','LIVE'],['mode','confirm'],['market','BTC/USD'],['market','SPX']]){const altered=previewInput();altered.fields[key]=value;fail(()=>validatePrivateDraftPreviewInput(altered),'PRIVATE_REQUEST_INVALID');}
 const wrong=previewInput();wrong.fields.botParameters=previewInput('previewBasket').fields.botParameters;fail(()=>validatePrivateDraftPreviewInput(wrong),'PRIVATE_REQUEST_INVALID');
});

test('numeric units stay numeric, finite and within amount, cap and research-budget bounds',()=>{
 for(const [key,values]of [['amount',[0,9.99,1000.01,NaN,Infinity,'20 USDT',true]],['cap',[9,3001,'300',Infinity]],['researchBudget',[-1,10001,.5,'0',true]]])for(const value of values){const input=previewInput();input.fields[key]=value;fail(()=>validatePrivateDraftPreviewInput(input),'PRIVATE_REQUEST_INVALID');}
 const bad=previewInput();bad.fields.amountUnit='USDT';fail(()=>validatePrivateDraftPreviewInput(bad),'PRIVATE_REQUEST_INVALID');
 const allowed=previewInput('previewEmpty');allowed.fields.amount=10;allowed.fields.cap=10;allowed.fields.researchBudget=10000;assert.deepEqual(validatePrivateDraftPreviewInput(allowed),allowed);
});

test('grid ranges, optional trigger/exit prices and exact decimal fee-inclusive capacity follow the shared backend rules',()=>{
 for(const patch of [{lower:0},{upper:60000},{count:1},{count:101},{count:2.5},{spacing:'linear'},{triggerPrice:59999},{triggerPrice:70001},{takeProfitPrice:70000},{stopLossPrice:60000},{upper:1e12+1}]){const input=previewInput();Object.assign(input.fields.botParameters,patch);fail(()=>validatePrivateDraftPreviewInput(input),'PRIVATE_REQUEST_INVALID');}
 const input=previewInput();input.fields.cap=80.08;assert.deepEqual(validatePrivateDraftPreviewInput(input),input);input.fields.cap=80.07999999999998;fail(()=>validatePrivateDraftPreviewInput(input),'PRIVATE_REQUEST_INVALID');
 const nullable=previewInput();Object.assign(nullable.fields.botParameters,{lower:null,upper:null,count:null,spacing:null});nullable.fields.cap=20;assert.deepEqual(validatePrivateDraftPreviewInput(nullable),nullable);
});

test('basket percentages and bounded scale-in capacity retain percent units and exact decimal boundaries',()=>{
 for(const patch of [{deviationPct:0},{deviationPct:100},{sizeMultiplier:.99},{sizeMultiplier:10.01},{maxEntries:0},{maxEntries:4},{maxEntries:1.5},{takeProfitPct:0},{takeProfitPct:1000.1},{stopLossPct:100},{triggerPrice:-1}]){const input=previewInput('previewBasket');Object.assign(input.fields.botParameters,patch);fail(()=>validatePrivateDraftPreviewInput(input),'PRIVATE_REQUEST_INVALID');}
 const input=previewInput('previewBasket');input.fields.cap=95.095;assert.deepEqual(validatePrivateDraftPreviewInput(input),input);input.fields.cap=95.09499999999998;fail(()=>validatePrivateDraftPreviewInput(input),'PRIVATE_REQUEST_INVALID');
 const nullable=previewInput('previewBasket');nullable.fields.botParameters.maxEntries=null;nullable.fields.cap=20;assert.deepEqual(validatePrivateDraftPreviewInput(nullable),nullable);
});

test('original, legacy H5 and parameterized protection retain their exact versioned boundaries without issuing approval',()=>{
 const parameters={episode:.0025,notional:.1,daily:.02,epoch:.05,soft:.03,hard:.08};
 for(const protection of [{id:'original',version:'strategy-original'},{id:'astarter',version:'astarter-research-v0.1/sim-2',mode:'normal'},{id:'astarter',version:'astarter-research-v0.1/sim-3',mode:'conservative',parameters}]){const input=previewInput();input.fields.protection=protection;assert.deepEqual(validatePrivateDraftPreviewInput(input),input);}
 for(const patch of [{episode:0},{episode:.0026},{notional:.101},{daily:.021},{epoch:.051},{soft:.031},{hard:.081},{soft:.01,hard:.01}]){const input=previewInput();input.fields.protection={id:'astarter',version:'astarter-research-v0.1/sim-3',mode:'normal',parameters:{...parameters,...patch}};fail(()=>validatePrivateDraftPreviewInput(input),'PRIVATE_REQUEST_INVALID');}
 for(const protection of [{id:'original',version:'strategy-original',approved:true},{id:'astarter',version:'kelly-live',mode:'normal'},{id:'astarter',version:'astarter-research-v0.1/sim-2',mode:'aggressive'}]){const input=previewInput();input.fields.protection=protection;fail(()=>validatePrivateDraftPreviewInput(input),'PRIVATE_REQUEST_INVALID');}
});

test('execution-route metadata is confined to the exact SIM-01 Binance spot route',()=>{
 for(const [key,value]of [['profileId','perpetual'],['venueId','okx'],['accountId','LIVE-01'],['chainId','56'],['connectionId','https://example.test'],['connectionId',''],['connectionId','sk-or-v1-'+'x'.repeat(24)],['connectionId','0x'+'a'.repeat(64)]]){const input=previewInput();input.fields.executionRoute[key]=value;fail(()=>validatePrivateDraftPreviewInput(input),'PRIVATE_REQUEST_INVALID');}
});

test('source identities, original report/evidence revisions, units and source clocks cannot be replaced with prose or client authority',()=>{
 for(const [key,value]of [['kind','public-report'],['sourceRequestId','bad'],['requestFingerprint','A'.repeat(64)],['reportRevision','unknown'],['evidenceRevision',null],['symbol','ETH'],['evidenceId','market-bad'],['methodVersion','fixture'],['createdAt',NaN],['validUntil','1794873600000']]){const valueDoc=document();valueDoc.content.source[key]=value;fail(()=>validatePrivateDraftDocument(valueDoc,OWNER));}
 for(const patch of [{unit:'milliseconds'},{sampleAt:1794700800000},{closedAt:1794700800},{validUntil:1794787200}]){const valueDoc=document();Object.assign(valueDoc.content.source.sourceClock,patch);fail(()=>validatePrivateDraftDocument(valueDoc,OWNER));}
 const valueDoc=document();valueDoc.content.source.ownerRef=OTHER;fail(()=>validatePrivateDraftDocument(valueDoc,OWNER));
});

test('savedAt uses the original report interval with an inclusive start and exclusive deadline, while historical receipts remain readable',()=>{
 for(const savedAt of [fixture.source.createdAt,fixture.source.validUntil-1]){
  const valueDoc=document();valueDoc.savedAt=savedAt;assert.deepEqual(validatePrivateDraftDocument(valueDoc,OWNER),valueDoc);
  const original=command();original.draft=valueDoc;original.request.appliedAt=savedAt;assert.deepEqual(validatePrivateDraftCommandResult(original,REQUEST,OWNER),original,'a historical receipt preserves the original report clocks without consulting current freshness');
 }
 for(const savedAt of [fixture.source.createdAt-1,fixture.source.validUntil,fixture.source.validUntil+1]){
  const valueDoc=document();valueDoc.savedAt=savedAt;fail(()=>validatePrivateDraftDocument(valueDoc,OWNER));
  const original=command();original.draft=valueDoc;original.request.appliedAt=savedAt;fail(()=>validatePrivateDraftCommandResult(original,REQUEST,OWNER));
 }
});

test('missingFields exactly describes nullable requirements and does not invent optional grid exits',()=>{
 const valueDoc=document('previewEmpty');assert.deepEqual(valueDoc.content.missingFields,['amount','botParameters','cap','executionRoute','protection','researchBudget']);assert.deepEqual(validatePrivateDraftDocument(valueDoc,OWNER),valueDoc);
 const h5=document();h5.content.fields.protection={id:'astarter',version:'astarter-research-v0.1/sim-2',mode:'normal'};h5.content.missingFields=['botParameters.stopLossPrice'];assert.deepEqual(validatePrivateDraftDocument(h5,OWNER),h5);
 for(const wrong of [[],['botParameters.triggerPrice'],['botParameters.stopLossPrice','botParameters.stopLossPrice']]){const altered=copy(h5);altered.content.missingFields=wrong;fail(()=>validatePrivateDraftDocument(altered,OWNER));}
 for(const wrong of [[1n],[Symbol('missing')],[null],[{}]]){const altered=copy(h5);altered.content.missingFields=wrong;fail(()=>validatePrivateDraftDocument(altered,OWNER));}
});

test('response scopes, paper versions, authority and strict object shapes stay closed',()=>{
 for(const validate of [()=>validatePrivateDraftDocument(document(),OTHER),()=>validatePrivateDraftPreview(preview(),OTHER),()=>validatePrivateDraftCommandResult(command(),REQUEST,OTHER)])fail(validate);
 for(const [key,value]of [['catalogVersion','private-paper-draft-v2'],['templateVersion','S02-SIM@paper-v1'],['parameterOrigin','model-generated'],['executionAuthority','APPROVED']]){const valueDoc=document();valueDoc.content[key]=value;fail(()=>validatePrivateDraftDocument(valueDoc,OWNER));}
 for(const key of ['token','ownerRef','authorization']){const valueDoc=document();valueDoc[key]='private';fail(()=>validatePrivateDraftDocument(valueDoc,OWNER));}
 const wrong=document();wrong.scope='owner.with.dots';fail(()=>validatePrivateDraftDocument(wrong));
});

test('preview CAS versions, current-document binding and changedFields remain explicit and bounded',()=>{
 const value=preview();value.current=document();value.expectedRevision=1;value.listed=true;value.changedFields=[];assert.deepEqual(validatePrivateDraftPreview(value,OWNER),value);
 for(const patch of [{expectedRevision:0},{draftId:'different'},{current:{...document(),scope:OTHER}},{current:{...document(),revision:2}},{expectedRevision:1.5},{workspaceRevision:-1},{proposalRevision:'x'.repeat(64)},{listed:1},{changedFields:['fields','fields']},{changedFields:Array(21).fill('fields')}]){const altered={...copy(value),...patch};fail(()=>validatePrivateDraftPreview(altered,OWNER));}
 const original=preview();original.expectedRevision=1;fail(()=>validatePrivateDraftPreview(original,OWNER));
});

test('changedFields contains exactly the actually changed fixed groups in their frozen relative order',()=>{
 const fresh=preview();assert.deepEqual(validatePrivateDraftPreview(fresh,OWNER).changedFields,CHANGE_GROUPS);
 for(const fields of [[],['source'],[...CHANGE_GROUPS].reverse(),['fields.amount','fields.botParameters.lower']]){const value=preview();value.changedFields=fields;fail(()=>validatePrivateDraftPreview(value,OWNER));}
 const existing=preview();existing.current=document();existing.expectedRevision=1;existing.changedFields=[];
 existing.current.content.source=Object.fromEntries(Object.entries(existing.current.content.source).reverse());assert.deepEqual(validatePrivateDraftPreview(existing,OWNER),existing,'JSONB object-key order is not a field change');
 existing.proposal.fields.amount=21;existing.changedFields=['fields.amount'];assert.deepEqual(validatePrivateDraftPreview(existing,OWNER),existing);
 for(const fields of [[],['source'],['fields.amount','fields.cap'],['fields.botParameters.lower']]){const value=copy(existing);value.changedFields=fields;fail(()=>validatePrivateDraftPreview(value,OWNER));}
 existing.proposal.source.reportRevision='c'.repeat(64);existing.changedFields=['source','fields.amount'];assert.deepEqual(validatePrivateDraftPreview(existing,OWNER),existing);existing.changedFields.reverse();fail(()=>validatePrivateDraftPreview(existing,OWNER));
});

test('adopt inputs carry the opaque original preview token and exact nonnegative CAS versions',()=>{
 const input=adoptInput();assert.equal(validatePrivateDraftAdoptInput(input).proposalRevision,TOKEN);
 for(const [key,value]of [['requestId','bad'],['expectedRevision',-1],['expectedRevision',Number.MAX_SAFE_INTEGER+1],['workspaceRevision',.5],['proposalRevision','B'.repeat(64)]]){const altered=copy(input);altered[key]=value;fail(()=>validatePrivateDraftAdoptInput(altered),'PRIVATE_REQUEST_INVALID');}
});

test('command receipts bind the original request and scope to exactly one draft revision and at most one workspace increment',()=>{
 const value=command();assert.deepEqual(validatePrivateDraftCommandResult(value,REQUEST,OWNER),value);value.request.workspaceRevision=2;assert.deepEqual(validatePrivateDraftCommandResult(value,REQUEST,OWNER),value);
 for(const patch of [{requestId:'other-request'},{draftId:'other-draft'},{status:'pending'},{expectedRevision:1},{revision:2},{workspaceBaseRevision:4},{workspaceRevision:4},{appliedAt:NOW+1}]){const altered=command();Object.assign(altered.request,patch);fail(()=>validatePrivateDraftCommandResult(altered,REQUEST,OWNER));}
 const other=command();other.draft.scope=OTHER;fail(()=>validatePrivateDraftCommandResult(other,REQUEST,OWNER));
});

test('accessors, forged prototypes, hidden fields and sparse or decorated response arrays fail without running getters',()=>{
 let called=0;const input=previewInput();Object.defineProperty(input.fields,'amount',{get(){called++;return 20;},enumerable:true});fail(()=>validatePrivateDraftPreviewInput(input),'PRIVATE_REQUEST_INVALID');assert.equal(called,0);
 const cases=[value=>Object.setPrototypeOf(value,{inherited:true}),value=>Object.defineProperty(value,'secret',{value:'hidden'}),value=>Object.defineProperty(value,Symbol('secret'),{value:'hidden'}),value=>{value.changedFields=new Array(1);},value=>{value.changedFields.extra='secret';},value=>Object.defineProperty(value.changedFields,'0',{get(){called++;return 'fields';},enumerable:true})];
 for(const alter of cases){const value=preview();alter(value);fail(()=>validatePrivateDraftPreview(value,OWNER));}assert.equal(called,0);
});
