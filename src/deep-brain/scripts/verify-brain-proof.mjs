import {readFile} from 'node:fs/promises';
import {buildProofCohort} from '../brain-proof-cohort.mjs';
import {evaluateDecisionProof} from '../brain-decision-proof.mjs';
import {inspectForwardComparison} from '../brain-forward-comparison.mjs';
import {verifyForwardProof} from '../brain-proof-forward.mjs';

const [file]=process.argv.slice(2);
if(file){
  const record=JSON.parse(await readFile(file,'utf8'));
  const proof=record.forward??record;
  const rebuilt=verifyForwardProof(proof);
  // Old downloads may predate dispatch records. Report only what those bytes contain.
  const audit=evaluateDecisionProof(proof,{assetKey:rebuilt.asset,date:rebuilt.targetOpenAt.slice(0,10),checkedAt:Date.now()});
  const comparison=inspectForwardComparison(proof,proof.comparisonPlan,{checkedAt:Date.now()});
  console.log(JSON.stringify({record:rebuilt,decisionProof:audit,comparison},null,2));
  if(audit.status==='blocked')process.exitCode=1;
}else{
  const archive=JSON.parse(await readFile(new URL('../brain-evidence/daily-markets.json',import.meta.url),'utf8'));
  console.log(JSON.stringify(buildProofCohort(archive,{days:90}),null,2));
}
