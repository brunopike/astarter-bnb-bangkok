import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {bundledMarket,readMemory,selectCase,sha256,writeMemory} from './replay.mjs';
import {explainMemory,syncMemory} from './connections.mjs';
import {renderReceipt} from './view.mjs';
import {paperPageHTML} from './page.mjs';
const market=JSON.parse(await readFile(bundledMarket)).assets[0];
const day=86400, start=Date.UTC(2020,0,1)/1000;
function syntheticMarket(growth){
  let price=100;
  const bars=Array.from({length:200},(_,i)=>{
    const open=price;price*=1+growth;
    return [start+i*day,open,price*1.002,open*.999,price,10000];
  });
  return {retrievedAt:new Date((start+bars.length*day)*1000).toISOString(),assets:[{...market,bars}]};
}
const archive=syntheticMarket(.009);
test('a supplied market produces a fill or cash receipt with reconcilable costs',async()=>{
  const record=selectCase(archive),x=record.decision.execution;
  assert.equal(x.status,'filled');
  const {referenceMove,slippage,entryFee,exitFee}=record.attribution;
  assert.ok(Math.abs(referenceMove-slippage-entryFee-exitFee-x.netPnl)<1e-8);
  const idle=selectCase(syntheticMarket(0),{session:record.decision.barOpenAt.slice(0,10)});
  assert.equal(idle.decision.execution.status,'skipped');assert.equal(idle.attribution.entryFee,0);
  assert.throws(()=>selectCase(archive,{session:'invalid'}),/No decision/);
  for(const en of [true,false])assert.ok(renderReceipt(record,en).includes(record.asset.market));
});
test('the entry page waits for market selection and renders only the selected market',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'paper-page-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'market.json');await writeFile(file,JSON.stringify(archive));
  assert.doesNotMatch(await paperPageHTML(true,{archiveFile:file}),/<section>/);
  assert.match(await paperPageHTML(true,{archiveFile:file,asset:market.key}),/Net paper P&amp;L/);
});
test('immutable replay memories survive concurrent retries and refuse changed bytes',async t=>{
  const path=await mkdtemp(join(tmpdir(),'paper-memory-'));t.after(()=>rm(path,{recursive:true,force:true}));
  const record=selectCase(archive),ids=await Promise.all([writeMemory(path,record),writeMemory(path,record)]);
  assert.equal(ids[0],ids[1]);assert.deepEqual(await readMemory(path,ids[0]),record);
  await assert.rejects(readMemory(path,'../invalid'),/memory ID/);
  await writeFile(join(path,ids[0]+'.json'),'{}');await assert.rejects(readMemory(path,ids[0]),/checksum/);
});
test('hosted recall reuses the captured source and supplies its exact bytes to the model',async()=>{
  const record=selectCase(archive),content=JSON.stringify(record);
  const source={id:'test-id',originRef:'paper-replay:'+sha256(content),status:'completed',content};
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
