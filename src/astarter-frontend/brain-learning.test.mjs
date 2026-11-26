import test from 'node:test';
import assert from 'node:assert/strict';
import {nextLearningSession,linksLearningReceipt,buildBrainProof} from '../deep-brain/brain-proof-engine.mjs';
import archive from '../deep-brain/brain-evidence/daily-markets.json' with {type:'json'};

test('the review follows the first recalibration that could have observed the closed session',()=>{
  const {decisions}=buildBrainProof(archive);
  const index=decisions.findIndex(row=>row.execution.status==='filled');
  const receipt=decisions[index],next=nextLearningSession(decisions,receipt);
  assert.equal(next.id,decisions[index+2].id);
  assert.ok(linksLearningReceipt(receipt,next));
  assert.equal(linksLearningReceipt(receipt,decisions[index+1]),false);
  assert.equal(linksLearningReceipt(receipt,{...next,previousReceiptId:'other'}),false);
  assert.equal(linksLearningReceipt(receipt,{...next,assetKey:'coin:other'}),false);
  assert.equal(nextLearningSession(decisions,decisions.at(-1)),undefined);
});
