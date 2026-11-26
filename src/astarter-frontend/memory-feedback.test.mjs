import assert from 'node:assert/strict';
import test from 'node:test';
import {createMemoryFeedbackStore} from './memory-feedback-store.mjs';
import {collectMemoryFeedback,handleMemory,userKey} from './living-brain.mjs';

const address='0x1111111111111111111111111111111111111111';

test('feedback keeps shared pages and stores each kept return',async()=>{
 const store=createMemoryFeedbackStore(':memory:');
 const calls=[];
 const client=async(pathname,options={})=>{
  calls.push(pathname+JSON.stringify(options.body||{}));
  if(pathname.endsWith('/search'))return[
   {pageId:'p1',slug:'s01',title:'策略 S01',summary:'现货规则',pageType:'project',status:'active',similarity:0.82,matchedOn:'both'},
   {pageId:'p3',slug:'unclassified'},
   {pageId:'p4',slug:'conflicting'},
   {pageId:'p2',slug:'secret',title:'别人的方案',summary:'0x2222222222222222222222222222222222222222',pageType:'decision',status:'active',similarity:0.91,matchedOn:'semantic'}
  ];
  if(pathname.endsWith('/unclassified'))return {title:'Untagged draft',body:'Private notes'};
  if(pathname.endsWith('/conflicting'))return {title:'Conflicting origins',originRef:'strategy:S01',body:'originRef: user:aaaaaaaaaaaaaaaa:plan:S01:1'};
  if(pathname.endsWith('/secret'))return{title:'别人的方案',slug:'secret',status:'active',body:'originRef: user:aaaaaaaaaaaaaaaa:plan:S01:1\n金额: 9'};
  return{title:'策略 S01',slug:'s01',status:'active',body:'策略编号: S01\noriginRef: strategy:S01'};
 };
 const user={key:userKey(address)};
 const outcome=await collectMemoryFeedback(user,{query:'S01 现货',topK:5,minSimilarity:0.35},{client,store});
 assert.equal(outcome.status,200);
 assert.equal(outcome.body.memory,true);
 assert.equal(outcome.body.results.length,1);
 assert.equal(outcome.body.results[0].slug,'s01');
 assert.equal(outcome.body.results[0].originRef,'strategy:S01');
 const saved=store.list(user.key,10);
 assert.equal(saved.length,2);
 assert.equal(saved.some(row=>JSON.stringify(row.payload).includes('aaaaaaaaaaaaaaaa')),false);
 assert.equal(saved.some(row=>JSON.stringify(row.payload).includes('0x2222')),false);
 assert.equal(calls[0].includes('"topK":5'),true);
 store.close();
});

test('another caller cannot read the stored feedback',()=>{
 const store=createMemoryFeedbackStore(':memory:');
 store.save({requester:'aaaa',kind:'search',query:'S01',slug:'',payload:{title:'S01'}});
 assert.equal(store.list('bbbb',10).length,0);
 assert.equal(store.list('aaaa',10)[0].query,'S01');
 assert.equal(store.all('bbbb').length,0);
 assert.equal(store.all('aaaa').length,1);
 store.close();
});

test('a blank query is rejected before Living Brain is called',async()=>{
 const store=createMemoryFeedbackStore(':memory:');
 let called=0;
 const outcome=await collectMemoryFeedback({key:'aaaa'},{query:'  '},{client:async()=>{called++;return[];},store});
 assert.equal(outcome.status,400);
 assert.equal(called,0);
 assert.equal(store.list('aaaa',10).length,0);
 store.close();
});


test('record and log endpoints use the signed-in owner even if a different owner is requested',async t=>{
 const store=createMemoryFeedbackStore(':memory:');
 t.after(()=>store.close());
 for(const name of ['alice','bob'])store.save({requester:name,kind:'search',query:name,slug:'',payload:{}});
 for(const path of ['records','feedback/log']){
  const req={url:`/api/memory/${path}?requester=bob`,method:'GET'};
  const response={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
  await handleMemory(req,response,{store,sessionUser:()=>null});
  assert.equal(response.status,401);
  await handleMemory(req,response,{store,sessionUser:()=>({key:'alice'})});
  assert.equal(response.status,200);
  assert.deepEqual(response.body.records.map(row=>row.query),['alice']);
 }
});
