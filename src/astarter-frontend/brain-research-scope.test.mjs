import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchScope} from './brain-research-scope.mjs';
import {brainAssetKey,brainCatalog} from './brain-asset-data.mjs';
import {notes} from './brain-case-notes.mjs';

test('same ticker on different chains has independent notes, sources and source times',()=>{
  const tokens=brainCatalog.filter(a=>a.symbol==='USDC' && a.address);
  assert.ok(new Set(tokens.map(a=>a.chain)).size>=2);
  const [a,b]=tokens;
  assert.notEqual(brainAssetKey(a),brainAssetKey(b));
  const first=createResearchScope(a,brainCatalog),second=createResearchScope(b,brainCatalog);
  assert.notDeepEqual(first.notes[5].body,second.notes[5].body);
  assert.match(first.notes[5].body[0],new RegExp(a.address,'i'));
  assert.equal(first.notes[6].sourceUrl,a.sourceUrl);
  assert.equal(second.asOf,b.receivedAt);
  assert.deepEqual(first.notes.map(n=>[n.group,n.level]),notes.map(n=>[n.group,n.level]));
  assert.doesNotMatch(JSON.stringify([first,second]),/15,537,394|Ethereum Merge|2022-09-15/);
});
test('unknown market network and null quotes stay unknown, while a measured zero is preserved',()=>{
  const a={id:'test-asset',symbol:'TEST',name:'Test',chain:null,address:null,provider:'Test feed',
    sourceUrl:null,price:null,volume:0,change:0,liquidity:null,asOf:null,receivedAt:null};
  const view=createResearchScope(a,[a]);
  assert.equal(view.asOf,null);
  assert.equal(view.notes[5].body[1],'Network not supplied');
  assert.equal(view.notes[6].body[1],'Unavailable');
  assert.equal(view.change,'0%');
  assert.match(view.volume,/\$0/);
  assert.equal(view.notes[8].body[1],'Unavailable');
  assert.equal(view.tape.asOf,null);
});
test('the network overview uses available records and never attaches a single asset source to the whole network',()=>{
  const result=createResearchScope(null,brainCatalog);
  assert.equal(result.notes.length,14);
  assert.equal(result.asset,null);
  assert.ok(result.marketRows.length);
  assert.ok(result.notes.every(n=>!n.sourceUrl));
  assert.equal(result.asOf,[...brainCatalog].map(a=>a.receivedAt).filter(Boolean).sort().at(-1));
});
