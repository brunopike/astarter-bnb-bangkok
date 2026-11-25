import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateApiRoute} from './private-api-route.mjs';

function response(){return {writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=JSON.parse(body);}};}
test('native and rewritten routes reach the same canonical handler and restore the request URL',async()=>{
 for(const [group,paths]of [['research',['analyze','requests/request-0001','requests/request:0001']],['wallet',['nonce','message','verify','session','logout','invitation']]]){
  for(const path of paths)for(const url of [`/api/${group}/${path}`,`/api/${group}?route=${encodeURIComponent(path)}`,`/api/${group}/${path}?route=${encodeURIComponent(path)}`,`/api/${group}/${path.split('/').map(encodeURIComponent).join('/')}`,`/api/${group}/${path.split('/').map(encodeURIComponent).join('/')}?route=${encodeURIComponent(path)}`]){
   const req={url,method:'POST',headers:{},body:{retained:true}},body=req.body;
   let calls=0;const handle=createPrivateApiRoute(group,async incoming=>{calls++;assert.equal(incoming,req);assert.equal(incoming.url,`/api/${group}/${path}`);assert.equal(incoming.body,body);return true;});
   assert.equal(await handle(req,response()),true);assert.equal(req.url,url);assert.equal(calls,1);
  }
 }
});
test('unrecognized, duplicate, query-injected and foreign routes are rejected before any private call',async()=>{
 let calls=0;const handle=createPrivateApiRoute('research',()=>calls++);
 for(const url of ['/api/research/%E0','/api/research','/api/research?route=analyze&route=analyze','/api/research/analyze?route=requests%2Frequest-0001','/api/research/analyze?route=analyze&route=analyze','/api/research/analyze?user_id=other','/api/research?route=analyze&user_id=other','/api/research?route=requests%2Fbad','/api/research?route=requests%2Frequest-0001%2Fother','/api/wallet/session','https://evil.example/api/research/analyze','//evil.example/api/research/analyze','/api/research?route=..%2Fwallet%2Fsession','/api/research?route='+ 'a'.repeat(2050)]){
  const req={url},res=response();await handle(req,res);assert.equal(res.status,400);assert.equal(req.url,url);assert.equal(res.body.executionAuthority,'NONE');assert.equal(res.headers['Cache-Control'],'no-store');
 }
 assert.equal(calls,0);
});
test('a handler exception also restores the request URL and cannot turn into a successful response',async()=>{
 const handle=createPrivateApiRoute('wallet',async()=>{throw Error('owner-unavailable');}),req={url:'/api/wallet?route=session'};
 await assert.rejects(()=>handle(req,response()),/owner-unavailable/);assert.equal(req.url,'/api/wallet?route=session');
});
test('account route rewrites preserve only the original query for the strict UI façade',async()=>{
 for(const [group,path,query] of [['workspace','state',''],['workspace','save',''],['workspace','request','requestId=request-0001'],['notifications','state','cursor=notice-001&limit=20'],['notifications','command',''],['notifications','request','requestId=request-0001']]){
  for(const url of [`/api/${group}/${path}${query?'?'+query:''}`,`/api/${group}?route=${path}${query?'&'+query:''}`]){
   let reached;const req={url},handle=createPrivateApiRoute(group,async r=>{reached=r.url;});await handle(req,response());assert.equal(reached,`/api/${group}/${path}${query?'?'+query:''}`);assert.equal(req.url,url);
  }
 }
});
test('account route ambiguity, other groups and fragments never reach the UI backend',async()=>{
 let calls=0;const handle=createPrivateApiRoute('workspace',()=>calls++);
 for(const url of ['/api/workspace?route=state&route=save','/api/workspace/save?route=state','/api/workspace?route=..%2Fwallet%2Fverify','/api/workspace?route=state%3Fowner%3Devil','/api/workspace/state#ignored','/api/notifications/state']){const req={url},res=response();await handle(req,res);assert.equal(res.status,400);assert.equal(req.url,url);}assert.equal(calls,0);
});
