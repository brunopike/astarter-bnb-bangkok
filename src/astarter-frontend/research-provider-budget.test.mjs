import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchProviderBudget} from './research-provider-budget.mjs';

const NOW=Date.UTC(2026,10,16,12),KEY='test-only-provider-key-never-sent-to-a-network';
const metadata=(patch={})=>({data:{label:'untrusted private label',limit:50,limit_remaining:49.123456,limit_reset:'monthly',usage_monthly:.876544,is_management_key:false,...patch}});
const json=(value,options={})=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'},...options});
const create=(fetchImpl,options={})=>createResearchProviderBudget({apiKey:KEY,fetchImpl,now:()=>NOW,...options});

test('construction and invalid configuration do no I/O, including absent, malformed and over-50USD configurations',async()=>{
 let calls=0;const fetchImpl=()=>{calls++;};assert.equal(create(fetchImpl).configured,true);assert.equal(calls,0);
 for(const options of [{apiKey:''},{apiKey:'too-short'},{apiKey:KEY+'\n'},{apiKey:'x'.repeat(513)},{maxMicrousd:50000001},{maxMicrousd:0},{timeoutMs:Infinity},{timeoutMs:9000}]){
  const gate=create(fetchImpl,options);assert.equal(gate.configured,false);await assert.rejects(()=>gate.verify(),{message:'PROVIDER_BUDGET_UNCONFIGURED'});
 }
 assert.equal(calls,0);
});

test('fixed official read returns exactly a sanitized monthly cap proof, never label, key, digest or raw usage',async()=>{
 const calls=[],gate=create(async(url,options)=>{calls.push({url,options});return json(metadata());});
 const proof=await gate.verify();assert.deepEqual(proof,{checkedAt:NOW,limitMicrousd:50000000,remainingMicrousd:49123456,reset:'monthly'});
 assert.equal(calls[0].url,'https://openrouter.ai/api/v1/key');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.body,undefined);assert.equal(calls[0].options.headers.Authorization,'Bearer '+KEY);
 assert.ok(calls[0].options.signal.aborted);assert.doesNotMatch(JSON.stringify(proof),/label|key|hash|usage|untrusted/);
});

test('a smaller lifetime cap is accepted while repeated verification always rereads the provider',async()=>{
 let calls=0;const gate=create(async()=>{calls++;return json(metadata({limit:25,limit_remaining:0,limit_reset:null,usage_monthly:25}));});
 assert.deepEqual(await gate.verify(),{checkedAt:NOW,limitMicrousd:25000000,remainingMicrousd:0,reset:null});await gate.verify();assert.equal(calls,2);
});

test('decimal ceiling prevents fractional-microdollar or exponent over-cap rounding from passing',async()=>{
 for(const limit of [50.000000000001,50.0000001,5.00000001e1,51])await assert.rejects(()=>create(async()=>json(metadata({limit,limit_remaining:0}))).verify(),{message:'PROVIDER_BUDGET_EXCEEDED'});
 assert.equal((await create(async()=>json(metadata({limit:.0000001,limit_remaining:.00000001}))).verify()).limitMicrousd,1);
 assert.equal((await create(async()=>json(metadata({limit:25,limit_remaining:1.0000001})),{maxMicrousd:25000000}).verify()).remainingMicrousd,1000001);
 await assert.rejects(()=>create(async()=>json(metadata()),{maxMicrousd:49000000}).verify(),{message:'PROVIDER_BUDGET_EXCEEDED'});
});

test('uncapped, management, missing, string, negative, nonfinite, wrong-cycle and inconsistent metadata all fail closed',async()=>{
 const patches=[{limit:null},{limit:0},{limit:-1},{limit:'50'},{limit:Infinity},{limit_reset:undefined},{limit_reset:'daily'},{limit_reset:'weekly'},{limit_reset:'month'},{limit_reset:0},{is_management_key:true},{is_management_key:undefined},{is_management_key:'false'},{limit_remaining:null},{limit_remaining:'49'},{limit_remaining:-1},{limit_remaining:51},{limit_remaining:NaN},{usage_monthly:null},{usage_monthly:'0'},{usage_monthly:-1},{usage_monthly:Infinity},{usage_monthly:undefined}];
 for(const patch of patches)await assert.rejects(()=>create(async()=>json(metadata(patch))).verify(),{message:'PROVIDER_BUDGET_INVALID'});
 for(const body of [null,[],{},metadata().data,{data:null},{data:[]},{...metadata(),extra:true}])await assert.rejects(()=>create(async()=>json(body)).verify(),{message:'PROVIDER_BUDGET_INVALID'});
});

test('HTTP failures, redirected or foreign responses, non-JSON and malformed JSON return only fixed error codes',async()=>{
 const redirected=json(metadata());Object.defineProperty(redirected,'redirected',{value:true});const foreign=json(metadata());Object.defineProperty(foreign,'url',{value:'https://evil.invalid/key'});
 const cases=[[new Response('secret upstream detail',{status:401}),'PROVIDER_BUDGET_UNAVAILABLE'],[redirected,'PROVIDER_BUDGET_UNAVAILABLE'],[foreign,'PROVIDER_BUDGET_UNAVAILABLE'],[new Response('{}',{headers:{'Content-Type':'text/html'}}),'PROVIDER_BUDGET_INVALID'],[new Response('{',{headers:{'Content-Type':'application/json'}}),'PROVIDER_BUDGET_INVALID']];
 for(const [response,code]of cases)await assert.rejects(()=>create(async()=>response).verify(),{message:code});
 for(const type of ['text/json','application/notjson'])await assert.rejects(()=>create(async()=>json(metadata(),{headers:{'Content-Type':type}})).verify(),{message:'PROVIDER_BUDGET_INVALID'});
 await assert.rejects(()=>create(async()=>{throw Object.assign(Error(KEY+' private label'),{code:'DONT_ECHO',status:403});}).verify(),error=>error.message==='PROVIDER_BUDGET_UNAVAILABLE'&&!String(error).includes(KEY));
});

test('both declared and streamed UTF8 response bodies have a strict 16KB cap',async()=>{
 for(const response of [json(metadata(),{headers:{'Content-Type':'application/json','Content-Length':'16385'}}),new Response(' '.repeat(16385),{headers:{'Content-Type':'application/json'}}),json(metadata({label:'😀'.repeat(5000)}))])await assert.rejects(()=>create(async()=>response).verify(),{message:'PROVIDER_BUDGET_INVALID'});
 const text=JSON.stringify(metadata()),padded=text+' '.repeat(16384-Buffer.byteLength(text));assert.equal((await create(async()=>new Response(padded,{headers:{'Content-Type':'application/json'}})).verify()).limitMicrousd,50000000);
});

test('the timeout bounds an uncooperative fetch and an unending body, cancelling both without a fallback proof',async()=>{
 let signal;await assert.rejects(()=>create(async(_url,options)=>{signal=options.signal;return new Promise(()=>{});},{timeoutMs:20}).verify(),{message:'PROVIDER_BUDGET_TIMEOUT'});assert.equal(signal.aborted,true);
 let cancelled=false;const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}});
 await assert.rejects(()=>create(async()=>response,{timeoutMs:20}).verify(),{message:'PROVIDER_BUDGET_TIMEOUT'});await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);
});

test('fetch and body consumption share one deadline, and invalid proof clocks are rejected',async()=>{
 let closed=false;const fetchImpl=async()=>{await new Promise(resolve=>setTimeout(resolve,15));return new Response(new ReadableStream({start(controller){setTimeout(()=>{if(!closed){controller.enqueue(new TextEncoder().encode(JSON.stringify(metadata())));controller.close();}},20);},cancel(){closed=true;}}),{headers:{'Content-Type':'application/json'}});};
 await assert.rejects(()=>create(fetchImpl,{timeoutMs:25}).verify(),{message:'PROVIDER_BUDGET_TIMEOUT'});
 for(const time of [NaN,-1,Infinity,1.5])await assert.rejects(()=>create(async()=>json(metadata()),{now:()=>time}).verify(),{message:'PROVIDER_BUDGET_INVALID'});
});
