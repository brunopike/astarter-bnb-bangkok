import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {bundledMarket,featuredCase,readMemory,selectCase,sha256,writeMemory} from './replay.mjs';
import {explainMemory,syncMemory} from './connections.mjs';
import {renderPaperCase} from './view.mjs';
const archive=JSON.parse(await readFile(bundledMarket));
test('selects the last fill without filtering its return and can inspect a skipped date',async()=>{
  const record=await featuredCase();
  assert.equal(record.decision.barOpenAt.slice(0,10),'2026-11-05');
  assert.equal(record.decision.execution.status,'filled');assert.equal(record.verification.matchedBars,93);
  const skipped=selectCase(archive,{session:'2026-11-25'});
  assert.equal(skipped.decision.execution.status,'skipped');assert.equal(skipped.attribution.entryFee,0);
  assert.throws(()=>selectCase(archive,{session:'1900-01-01'}),/No decision/);
  for(const en of [true,false])assert.match(renderPaperCase(record,en),/-24.8936/);
});
test('immutable replay memories survive concurrent retries and refuse changed bytes',async t=>{
  const path=await mkdtemp(join(tmpdir(),'paper-memory-'));t.after(()=>rm(path,{recursive:true,force:true}));
  const record=selectCase(archive),ids=await Promise.all([writeMemory(path,record),writeMemory(path,record)]);
  assert.equal(ids[0],ids[1]);assert.deepEqual(await readMemory(path,ids[0]),record);
  await assert.rejects(readMemory(path,'../invalid'),/memory ID/);
  await writeFile(join(path,ids[0]+'.json'),'{}');await assert.rejects(readMemory(path,ids[0]),/checksum/);
});
test('hosted recall reuses the captured source and supplies its exact bytes to the model',async()=>{
  const record=selectCase(archive),content=await readFile(new URL('./example/memory.txt',import.meta.url),'utf8');
  const source={id:'test-id',originRef:JSON.parse(content.split('\n')[1]).originRef,status:'completed',content};
  const env={LIVING_BRAIN_API_KEY:'test',LIVING_BRAIN_SUBJECT_ID:'test',LIVING_BRAIN_BRAIN_ID:'test',OPENAI_API_KEY:'test'};
  const recalled=await syncMemory(record,{env,fetchImpl:async(url,init)=>{
    assert.equal(init.method,undefined);assert.match(url,/\/sources\?/);return Response.json({total:1,items:[source]});
  }});
  const result=await explainMemory(record,{env,content:recalled.content,fetchImpl:async(url,init)=>{
    assert.equal(new URL(url).hostname,'api.openai.com');
    assert.equal(JSON.parse(init.body).input[1].content,content);
    return Response.json({status:'completed',model:'test',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Paper stop.'}]}]});
  }});
  assert.equal(result.inputSha256,sha256(content));assert.equal(result.receiptId,record.decision.execution.id);
  await assert.rejects(syncMemory(record,{env,fetchImpl:async()=>Response.json({total:1,items:[{...source,content:'changed'}]})}),/content mismatch/);
});
