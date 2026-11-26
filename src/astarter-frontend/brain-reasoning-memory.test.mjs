import test from 'node:test';
import assert from 'node:assert/strict';
import {allowed} from './public-assets.mjs';
import {getNodeHistory} from './brain-history.mjs';
import {graphEvidence,evidenceChildren} from './brain-evidence-nodes.mjs';
import {reasoningRecords} from './brain-reasoning-memory.mjs';
import archive from './brain-evidence/decision-cases.json' with {type:'json'};

test('case observations and reviews stay independently dated, sourced, scoped and linked',()=>{
  assert(archive.cases.length);
  const ids=new Set(reasoningRecords.map(r=>r.id));
  assert.equal(ids.size,reasoningRecords.length);
  for(const c of archive.cases){
    assert(Date.parse(c.reviewedAt)>Date.parse(c.observedAt),c.id);
    const id='decision/'+c.id+'/';
    const before=getNodeHistory(c.assets[0],4,c.observedAt);
    const seen=before.find(r=>r.id===id+'observation');
    assert(seen && !before.some(r=>r.id===id+'review'));
    assert(!JSON.stringify(seen.memorySections).includes(c.outcome[0]),c.id);
    assert(seen.memorySections.length && evidenceChildren(seen).length===c.facts.length);
    for(const part of evidenceChildren(seen)){
      assert(Array.isArray(part.label) && part.label.every(Boolean));
      assert(Date.parse(part.reference.publishedOn)<=Date.parse(c.observedAt));
      assert.match(part.reference.url,/^https:\/\//);
    }
    const after=getNodeHistory(c.assets[0],4,c.reviewedAt).find(r=>r.id===id+'review');
    assert.deepEqual(after.body,c.outcome);
    assert(after.relations.some(link=>link.id===seen.id));
    assert(seen.relations.some(link=>link.id===after.id));
    assert(!getNodeHistory('ca:base:unrelated',4,c.reviewedAt,'base').includes(after));
  }
  for(const row of reasoningRecords){
    for(const rel of row.relations)assert(ids.has(rel.id),rel.id);
    assert(row.topic?.length===2 && row.title.every(Boolean));
  }
});
test('reasoning records, their source details and the graph share the same IDs',()=>{
  const end='9999-12-31T00:00:00Z';
  const graph=new Map(graphEvidence('all',end,null,false).map(p=>[p.id,p]));
  for(const r of reasoningRecords){
    const star=graph.get(r.id);
    assert(star && getNodeHistory('all',star.parent,end).includes(r),r.id);
    evidenceChildren(r).forEach((part,i)=>assert.deepEqual(graph.get(r.id+'@'+i).label,part.label[0]));
  }
  for(const path of ['brain-reasoning-memory.mjs','brain-evidence/decision-cases.json','brain-evidence/market-reactions.json'])assert(allowed.has(path));
});
