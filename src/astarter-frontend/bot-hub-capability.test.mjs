import test from 'node:test';
import assert from 'node:assert/strict';
import {CATALOG} from './strategy-catalog.mjs';
import {STRATEGY_MARKETS,strategyMarkets} from './strategy-routing.mjs';
import {strategyPlan,defaultBotVariant} from './strategy-execution-data.mjs';
import {pair as L} from './locale.mjs';
import {botEntryCapability,botHubCards,renderBotOverview,createBotHub} from './bot-hub.mjs';

const PROFILE_IDS=STRATEGY_MARKETS.map(p=>p.id);

test('every catalog entry has a clear destination and an entry capability read from routing and the simulation gate',()=>{
 const trade={botBook:{runs:[]}},cards=botHubCards(trade);
 assert.equal(CATALOG.length,18);assert.equal(cards.length,CATALOG.length);
 for(const item of CATALOG){
  const capability=botEntryCapability(item.id),card=cards.find(c=>c.id===item.id);
  assert.ok(card,`missing card ${item.id}`);
  assert.deepEqual(card.capability,capability);
  assert.ok(['simulate','workspace','research'].includes(capability.action));
  assert.equal(capability.action==='simulate',card.ready,`action and readiness agree for ${item.id}`);
  assert.equal(capability.action==='workspace',!card.ready&&Boolean(strategyPlan(item.id,defaultBotVariant(item.id))?.flowAvailable),`a workspace entry follows the plan's own flow for ${item.id}`);
  assert.deepEqual(capability.profiles,strategyMarkets(item.id));
  assert.ok(capability.profiles.length>0&&capability.profiles.every(id=>PROFILE_IDS.includes(id)));
  assert.equal(capability.markets.length,capability.profiles.length);
  for(const pair of [capability.requirements,capability.actions,...capability.markets]){assert.equal(pair.length,2);assert.ok(pair.every(text=>typeof text==='string'&&text.length));}
  for(const pair of [capability.requirements,capability.actions])assert.ok(pair.includes(L(...pair)),`the shown text is the written text for ${item.id}: ${pair[0]}`);
 }
 assert.equal(botEntryCapability('perp-grid'),null,'an id outside the catalog has no entry capability');
 assert.equal(botEntryCapability(undefined),null);
 assert.deepEqual(CATALOG.filter(item=>botEntryCapability(item.id).action==='workspace').map(item=>item.id),['S03']);
 assert.deepEqual(botEntryCapability('S03').requirements,strategyPlan('S03','baseline').need);
});

test('strategies without a run path offer research and saved plans only, never a launch',()=>{
 const html=renderBotOverview({w:{s:{drafts:[]}},trade:{botBook:{runs:[]}}});
 const runLine=L(...botEntryCapability('S01').actions);
 assert.match(runLine,/本机运行|Local run/,'the shown run action is the written one');
 for(const item of CATALOG){
  const capability=botEntryCapability(item.id),body=html.split(`data-bot-strategy="${item.id}"`)[1].split('</article>')[0];
  assert.ok(body.includes(`data-entry-action="${capability.action}"`));
  assert.ok(body.includes(`data-bh="choose" data-id="${item.id}"`),`entry ${item.id} opens the existing workspace`);
  assert.match(body,/运行条件|Requirements/);assert.match(body,/可用操作|Available actions/);
  assert.ok(body.includes(`<dd>${L(...capability.actions)}</dd>`),`entry ${item.id} shows its rendered action line`);
  assert.ok(body.includes(`<dd>${L(...capability.requirements)}</dd>`),`entry ${item.id} shows its rendered requirement`);
  if(capability.action==='research'){
   assert.match(body,/仅研究|Research only/);assert.match(body,/研究方案|Research plan/);
   assert.doesNotMatch(body,/本地模拟|Local simulation|本机运行|Local run|>启动<|>Launch</);assert.ok(!body.includes(runLine));
  }
  if(capability.action==='workspace'){
   assert.ok(body.includes(`<dd>${L(...capability.requirements)}</dd>`),`entry ${item.id} shows its plan's own requirement`);
   assert.doesNotMatch(body,/仅研究|Research only|暂无可运行路径|No run path yet|本机运行|Local run|>启动<|>Launch</);assert.ok(!body.includes(runLine));
  }
 }
});

test('each strategy card names the wallet types its route can actually use',()=>{
 const html=renderBotOverview({w:{s:{drafts:[]}},trade:{botBook:{runs:[]}}});
 for(const item of CATALOG){
  const body=html.split(`data-bot-strategy="${item.id}"`)[1].split('</article>')[0];
  const shown=[...body.matchAll(/<span data-wallet-type>([^<]*)<\/span>/g)].map(match=>match[1]);
  const expected=[...(strategyMarkets(item.id).some(profile=>profile.startsWith('cex'))?[L('币安 CEX','Binance CEX')]:[]),L(...(String(item.id).startsWith('S09')?['Ethereum 钱包','Ethereum wallet']:['BNB Chain 钱包','BNB Chain wallet']))];
  assert.deepEqual(shown,expected,item.id);
 }
 const chain=html.split('data-bot-strategy="S09-A"')[1].split('</article>')[0];
 assert.doesNotMatch(chain,/BNB Chain/);
});
test('the catalog shows eligible markets without binding every entry to BTC or claiming every market',()=>{
 const html=renderBotOverview({w:{s:{drafts:[]}},trade:{botBook:{runs:[]}}});
 assert.doesNotMatch(html,/BTC\/USDT|BTCUSDT|data-token="BTC"/);
 assert.equal((html.match(/data-entry-market>/g)||[]).length,CATALOG.reduce((n,item)=>n+strategyMarkets(item.id).length,0));
 for(const item of CATALOG)assert.ok(botEntryCapability(item.id).profiles.length<PROFILE_IDS.length,`${item.id} does not claim every market`);
 assert.deepEqual(botEntryCapability('S09-A').profiles,['dex-spot']);
 assert.deepEqual(botEntryCapability('S09-L').profiles,['dex-lp']);
 assert.ok(CATALOG.every(item=>!botEntryCapability(item.id).profiles.some(id=>id.endsWith('perp'))),'no catalog entry claims a perpetual route the routing does not offer');
});

test('entries whose plan text and routing disagree keep their routed market tags until lane S confirms them',()=>{
 const html=renderBotOverview({w:{s:{drafts:[]}},trade:{botBook:{runs:[]}}});
 const routed={'RX02-P':['cex-spot','dex-spot'],'RX02-A':['cex-spot','dex-spot'],'RX03-S':['cex-spot','dex-spot'],RX04:['cex-spot','dex-spot'],RX05:['cex-spot','dex-spot'],'RX03-B':['cex-spot'],'S09-A':['dex-spot'],'S09-L':['dex-lp']};
 for(const [id,profiles]of Object.entries(routed)){
  assert.deepEqual(botEntryCapability(id).profiles,profiles,`${id} changes only with lane S's answer to handover request 4`);
  const body=html.split(`data-bot-strategy="${id}"`)[1].split('</article>')[0];
  const shown=[...body.matchAll(/<span data-entry-market>([^<]*)<\/span>/g)].map(m=>m[1]);
  assert.deepEqual(shown,profiles.map(key=>{const p=STRATEGY_MARKETS.find(row=>row.id===key);return L(p.zh,p.en);}));
 }
});

test('adding an Agent returns to the same scroll position and trigger after leaving the workspace',async t=>{
 const raf=globalThis.requestAnimationFrame;
 globalThis.requestAnimationFrame=fn=>fn();
 t.after(()=>{if(raf===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=raf;});
 const add={dataset:{bh:'create'}},focused=[],chosen=[];let refreshed=0;
 const trigger={focus:()=>focused.push('create')};
 const root={scrollTop:420,dataset:{renderedPage:'strategies'},querySelectorAll:s=>s==='[data-bh]'?[add]:[],querySelector:s=>s==='[data-bh="create"]'?trigger:null};
 createBotHub({w:{s:{}},desk:{},root,go:()=>assert.fail('No page change without a create link'),refresh:()=>refreshed++,choose:(id,back)=>chosen.push([id,back]),show:()=>assert.fail('Creation is a page')}).bind();
 await add.onclick();
 assert.equal(chosen.length,1);assert.equal(chosen[0][0],'S01');assert.equal(typeof chosen[0][1],'function');
 root.scrollTop=0;chosen[0][1]();
 assert.equal(refreshed,1);assert.equal(root.scrollTop,420);assert.deepEqual(focused,['create']);
});
