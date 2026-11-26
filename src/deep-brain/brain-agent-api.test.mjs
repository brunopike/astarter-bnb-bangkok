import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import archive from './brain-evidence/daily-markets.json' with {type:'json'};
import {createBrainProofHandler} from './api/brain-proof.mjs';
import {createBrainProofService,readAgentBrief} from './api/brain-proof-service.mjs';
import {readForwardProof,readForwardRefusal,recordForwardProofs} from './brain-proof-forward.mjs';
import {readSourceObservation} from './brain-source-observations.mjs';
import {observeTestArchive} from './test-brain-observations.mjs';

async function request(handler,url,method='GET'){
  let status,body;
  await handler({method,url},{writeHead(code){status=code;},end(bytes){body=bytes?JSON.parse(bytes):null;}});
  return {status,body};
}

test('agent endpoint and full review identify the same registered session, while recall stays at registration time',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'brain-agent-api-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const asset=archive.assets.find(row=>row.key==='coin:bitcoin');
  const data={retrievedAt:archive.retrievedAt,assets:[asset]};
  const registered=Date.parse(archive.retrievedAt)+60000;
  const clock=()=>registered;
  const file=path.join(dir,'market.json');
  await writeFile(file,JSON.stringify(data));
  await observeTestArchive(data,{dir,clock});
  assert.equal((await recordForwardProofs(data,{dir,clock})).registered,1);
  const handler=createBrainProofHandler({archiveFile:file,clock:()=>registered+5000,
    forward:(key,opts)=>readForwardProof(key,{...opts,dir}),refusal:(key,opts)=>readForwardRefusal(key,{...opts,dir}),
    observation:(key,opts)=>readSourceObservation(key,{...opts,dir})});
  const catalog=await request(handler,'/api/brain/proof');
  const tool=(await request(handler,catalog.body.agentTool)).body;
  assert.equal(tool.readOnly,true);
  assert.deepEqual(tool.inputSchema.required,['asset']);
  const brief=(await request(handler,tool.request.path+'?brief=1&asset='+asset.key)).body;
  const pinned=(await request(handler,brief.links.review)).body;
  assert.equal(brief.decisionId,pinned.decisionProof.decisionId);
  assert.equal(brief.execution.dispatchId,pinned.dispatch.sha256);
  assert.equal(brief.liveAuthorized,false);
  assert.equal(brief.memory.status,'empty');
  assert.equal(brief.memory.asOf,pinned.decisionProof.recordedAt);
  assert.equal(brief.thinking.sensitivity.omissions,60);
  assert.equal(pinned.decisionProof.assurance.strategy.sensitivity,undefined);
  assert.equal(brief.execution.receipt,null);
  assert.ok(Buffer.byteLength(JSON.stringify(brief))<7500);
});

test('tool transport validates its method, parameters and dates before producing a brief',async t=>{
  const service=createBrainProofService({archiveFile:fileURLToPath(new URL('./brain-evidence/daily-markets.json',import.meta.url))});
  t.after(()=>service.close());
  for(const query of ['?brief=1','?tool=1&asset=x','?brief=1&asset=x&date=2026-02-30','?brief=1&asset=x&asset=y','?brief=1&current=1&asset=x']){
    assert.equal((await request(service,'/api/brain/proof'+query)).status,400,query);
  }
  assert.equal((await request(service,'/api/brain/proof?brief=1&asset=x','POST')).status,405);
  assert.equal((await request(service,'/api/brain/proof?tool=1','HEAD')).body,null);
  const controller=new AbortController();
  controller.abort();
  await assert.rejects(readAgentBrief('coin:bitcoin',{signal:controller.signal}),{name:'AbortError'});
});
