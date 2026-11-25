import test from 'node:test';
import assert from 'node:assert/strict';
import {MultiResearch} from './multi-research.mjs';
import {MarketResearch} from './live-research.mjs';
import {WorkspaceSim,WORKSPACE_KEY} from './workspace-sim.mjs';

function store(){const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};}

test('live research never restores fixture conclusions and retains the previous demo and drafts',()=>{
 const storage=store(),demo=new MultiResearch();demo.advance(90);
 const original=new WorkspaceSim({storage,research:demo}),draft=original.createDraft('S01');original.persist();
 const before=JSON.parse(storage.getItem(WORKSPACE_KEY));assert.equal(before.research.tasks.find(t=>t.symbol==='ETH').outcome,'candidate');
 const live=new MarketResearch(),workspace=new WorkspaceSim({storage,research:live});
 assert.equal(live.mode,'live_readonly');assert.equal(live.handoff('ETH'),null);assert.notEqual(live.task('ETH').outcome,'candidate');
 assert.equal(workspace.draft(draft.id).id,draft.id);workspace.persist();
 const after=JSON.parse(storage.getItem(WORKSPACE_KEY));assert.deepEqual(after.research,before.research);assert.equal(after.marketResearch.mode,'live_readonly');
 const restoredDemo=new MultiResearch();new WorkspaceSim({storage,research:restoredDemo});
 assert.equal(restoredDemo.task('ETH').outcome,'candidate');assert.equal(restoredDemo.revision(restoredDemo.task('ETH')),demo.revision(demo.task('ETH')));
});

test('public candle analysis cannot reserve credits or pretend an unconnected model job completed',async()=>{
 const research=new MarketResearch(),workspace=new WorkspaceSim({research}),before=structuredClone(workspace.s.usage),credits=workspace.available;
 let called=false;workspace.account={runTask(){called=true;throw Error('Must not be called');}};
 assert.match(workspace.requestResearch('ETH'),/research service/i);
 assert.match(await workspace.requestPaidResearch('ETH'),/research service/i);
 assert.equal(called,false);assert.deepEqual(workspace.s.usage,before);workspace.account=null;assert.equal(workspace.available,credits);
});

test('saved research scope survives a live reload without restoring old market conclusions',()=>{
 const storage=store(),old=new WorkspaceSim({storage,research:new MultiResearch()});old.setScope('crypto');
 const live=new MarketResearch(),workspace=new WorkspaceSim({storage,research:live});
 assert.equal(workspace.s.scope,'crypto');assert.equal(live.scope,'crypto');assert.equal(live.accepts(live.task('XAU')),false);
 assert.equal(live.handoff('ETH'),null);
});

test('a matching numeric version cannot settle a legacy model job from a live candle receipt',()=>{
 const storage=store(),old=new WorkspaceSim({storage,research:new MultiResearch()});
 old.persist();
 const day=Date.UTC(2026,10,16)/1000,live=new MarketResearch({now:()=>day+3600}),workspace=new WorkspaceSim({storage,research:live});
 workspace.s.usage.push({id:'OLD-MODEL-JOB',kind:'深度核验',symbol:'BTC',version:2,ref:'research-BTC:v2',reserved:8,settled:0,status:'reserved',at:0});
 live.ingestMarket([{symbol:'BTC',source:'Binance Spot',timezone:'UTC',unit:'USDT',period:'1D',methodVersion:'ema20-atr14-rsi14-v1',feedState:'snapshot',state:'ready',paused:false,price:100,x:1,y:55,change:1,bars:299,signal:'balanced',sampleAt:day-86400,closedAt:day,validUntil:day+86400}]);
 assert.equal(live.task('BTC').version,2);assert.equal(live.task('BTC').phase,'complete');
 const credits=workspace.s.credits;workspace.tick(.1);assert.equal(workspace.s.credits,credits);
 assert.equal(workspace.s.usage[0].status,'reserved');assert.equal(workspace.s.usage[0].settled,0);
});
