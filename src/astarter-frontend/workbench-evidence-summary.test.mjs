import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeEvidence,workbenchEvidenceSummary} from './workbench-evidence-summary.mjs';
import {workbenchInsights} from './workbench-insights.mjs';

test('source states share one applicable denominator and leave input unchanged',()=>{
 const evidence=['pending','collected','retain','context','conflict','missing','na'].map((status,i)=>({key:String(i),status})),before=structuredClone(evidence);
 const result=summarizeEvidence(evidence);
 assert.equal(result.total,7);assert.equal(result.applicable,6);assert.equal(result.notApplicable,1);
 assert.deepEqual(result.segments.map(({status,count})=>[status,count]),[['pending',1],['collected',1],['retain',1],['context',1],['conflict',1],['missing',1]]);
 assert.equal(result.segments.reduce((sum,item)=>sum+item.count,0),result.applicable);
 assert.deepEqual(evidence,before);
});

test('unknown and missing states cannot become adopted or completed sources',()=>{
 const result=summarizeEvidence([{key:'a',status:'done'},{key:'b'},{key:'c',status:'missing'},{key:'d',status:'retain'}]);
 assert.deepEqual(result.segments.map(({status,count})=>[status,count]),[['retain',1],['missing',1],['unknown',2]]);
 assert.equal(result.applicable,4);
});

test('duplicate keys count once and contradictory duplicates stay unverified',()=>{
 const result=summarizeEvidence([{key:'a',status:'pending'},{key:'a',status:'pending'},{key:'b',status:'retain'},{key:'b',status:'context'},{key:'b',status:'retain'},null,{}, {key:' ',status:'retain'}]);
 assert.equal(result.total,2);
 assert.deepEqual(result.segments,[{status:'pending',count:1},{status:'unknown',count:1}]);
});

test('empty and wholly inapplicable sets never draw a progress ring',()=>{
 for(const evidence of [undefined,null,[],{}]){
  assert.equal(summarizeEvidence(evidence).total,0);
  const html=workbenchEvidenceSummary(evidence);assert.match(html,/暂无依据/);assert.doesNotMatch(html,/<svg|NaN|Infinity/);
 }
 const html=workbenchEvidenceSummary([{key:'chain',status:'na'}]);
 assert.doesNotMatch(html,/<svg/);assert.match(html,/不适用/);assert.match(html,/data-has-ring="false"/);
});

test('rendered counts remain stable when source order or narrative text changes',()=>{
 const evidence=[{key:'a',status:'pending'},{key:'b',status:'conflict'},{key:'c',status:'na'}];
 const html=workbenchEvidenceSummary(evidence,'evidence-a');
 assert.equal(workbenchEvidenceSummary(evidence.toReversed().map(item=>({...item,text:'changed',source:'changed'})),'evidence-a'),html);
 for(const label of ['适用来源','待采集','存在冲突','不适用'])assert.ok(html.includes(label));
 assert.doesNotMatch(html,/%|覆盖率|信心|模拟|计时|tabindex|<button|<canvas/);
 assert.match(html,/<svg[^>]+aria-hidden="true"/);
});

test('one state fills a ring without fractional gaps, and ids cannot inject markup',()=>{
 const html=workbenchEvidenceSummary([{key:'a',status:'retain'}],'x"><script>');
 assert.match(html,/stroke-dasharray="1 0"/);assert.match(html,/stroke-dashoffset="0"/);
 assert.doesNotMatch(html,/<script>|NaN|Infinity/);
 const mixed=workbenchEvidenceSummary(['pending','collected','retain','context','conflict','missing','unknown'].map(status=>({key:status,status})));
 const dashes=[...mixed.matchAll(/class="insight-evidence-(?:halo|dots)"[^>]+stroke-dasharray="([\d.]+) ([\d.]+)"/g)];
 assert.equal(dashes.length,14);
 for(const [,length,gap] of dashes){assert.ok(+length>0&&+length<1);assert.ok(Math.abs(+length+(+gap)-1)<.00001);}
});

test('an all-context source set stays one neutral state with fine radial grain',()=>{
 const evidence=Array.from({length:5},(_,i)=>({key:String(i),status:'context'})).concat({key:'chain',status:'na'});
 const html=workbenchEvidenceSummary(evidence),summary=summarizeEvidence(evidence);
 assert.deepEqual(summary.segments,[{status:'context',count:5}]);assert.equal(summary.applicable,5);assert.equal(summary.notApplicable,1);
 assert.doesNotMatch(html,/<pattern|<rect|data-evidence-state="(?:retain|collected|conflict)"|<animate/);
 const rows=[...html.matchAll(/class="insight-evidence-grain-row"[^>]+r="([\d.]+)"[^>]+stroke-width="([\d.]+)"[^>]+opacity="([\d.]+)"[^>]+stroke-dasharray="\.001 ([\d.]+)"/g)];
 assert.equal(rows.length,5);
 assert.ok(rows.every(([,r,width,opacity,gap])=>+r>35&&+r<45&&+width<=1.4&&+opacity>0&&+opacity<=1&&+gap>2.4&&+gap<2.6));
 for(const [,r,,,gap] of rows){const dots=2*Math.PI*(+r)/(+.001+(+gap));assert.ok(Math.abs(dots-Math.round(dots))<.003);}
 assert.ok(+rows[2][2]>+rows[0][2]&&+rows[2][3]>+rows[0][3]);
 assert.ok(+rows[2][2]>+rows[4][2]&&+rows[2][3]>+rows[4][3]);
 assert.match(html,/stroke-linecap="round"/);
});

test('the existing TradFi view supplies five applicable sources and one inapplicable source',()=>{
 const view=workbenchInsights({task:{symbol:'SPX',domain:'TradFi',evidence:[{key:'trend',status:'retain'},{key:'macro',status:'context'}]}});
 const summary=summarizeEvidence(view.evidence);
 assert.equal(summary.total,6);assert.equal(summary.applicable,5);assert.equal(summary.notApplicable,1);
 assert.deepEqual(summary.segments,[{status:'pending',count:3},{status:'retain',count:1},{status:'context',count:1}]);
});
