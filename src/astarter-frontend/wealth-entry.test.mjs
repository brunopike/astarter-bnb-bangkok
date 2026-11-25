import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createWealthEntry,wealthEntryCapability} from './wealth-entry.mjs';
import {WEALTH_ENTRY_CATALOG as catalog} from './wealth-entry-catalog.mjs';
import {pair} from './locale.mjs';

const raw=await readFile(new URL('./test-fixtures/wealth-strategy-config.draft-20261113.1.json',import.meta.url));
const config=JSON.parse(raw),configHash=createHash('sha256').update(JSON.stringify(config)).digest('hex');
const configuration=()=>({config:structuredClone(config),configHash,chainId:31337,liveEnabled:false,testFundingEnabled:true});
const response=value=>({ok:true,json:async()=>value});
function harness({url='https://astarter.imstark.site/?page=wealth',fetchImpl=async()=>response(configuration()),loadView,now,timeoutMs}={}){
 const calls=[],listeners=new Map(),host={innerHTML:''},slot={appendChild(node){node.parentNode=this;this.node=node;}};
 const root={ownerDocument:{createElement:()=>({innerHTML:'',parentNode:null})},contains:()=>true,
  addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);},
  querySelector(selector){return selector==='[data-wealth-entry]'?host:selector==='[data-wealth-entry-child]'&&host.innerHTML.includes('data-wealth-entry-child')?slot:null;}};
 let changed=0;
 const entry=createWealthEntry({root,dialog:{},show(){},href:()=>url,onChange(){changed++;},fetchImpl:(...args)=>{calls.push(args);return fetchImpl(...args);},loadView,now,timeoutMs});
 function action(value){const target={disabled:false,dataset:{wealthEntryAction:value}};listeners.get('click')?.({target:{closest:selector=>selector==='[data-wealth-entry-action]'?target:null}});}
 function choose(value){const target={dataset:{wealthEntryProfile:value}};listeners.get('click')?.({target:{closest:selector=>selector==='[data-wealth-entry-profile]'?target:null}});}
 function chooseAsset(value){const target={dataset:{wealthEntryAsset:value}};listeners.get('click')?.({target:{closest:selector=>selector==='[data-wealth-entry-asset]'?target:null}});}
 return {entry,root,host,slot,calls,listeners,action,choose,chooseAsset,visit:next=>{url=next;},changed:()=>changed};
}

test('public catalog exactly projects the existing candidate without balances or yield claims',()=>{
 assert.equal(catalog.sourceSHA256,createHash('sha256').update(raw).digest('hex'));
 assert.equal(catalog.sourceVersion,config.version);assert.equal(catalog.realFundingEnabled,false);
 assert.equal(catalog.profiles.length,4);assert.equal(catalog.assets.length,4);
 for(const p of catalog.profiles){const source=config.profiles.find(s=>s.id===p.id);for(const key of Object.keys(p))assert.deepEqual(p[key],source[key]);}
 for(const forbidden of ['apy','apr','holdingUnits','walletBalance','account','vaultAddress'])assert.equal(JSON.stringify(catalog).includes('"'+forbidden+'"'),false);
});

test('capability admits only an explicitly disabled-real-funding localhost test-chain contract',()=>{
 const local='http://127.0.0.1:4215/?page=wealth';assert.equal(wealthEntryCapability(configuration(),local).state,'local-test');
 for(const url of ['https://astarter.imstark.site/?page=wealth','http://127.0.0.1.evil.test:4215','file:///tmp/wealth.html','http://[::1]:4215'])assert.notEqual(wealthEntryCapability(configuration(),url).state,'local-test');
 for(const mutation of [{chainId:1},{liveEnabled:true},{testFundingEnabled:'yes'},{configHash:'wrong'},{config:{...config,liveEnabled:true}}])assert.equal(wealthEntryCapability({...configuration(),...mutation},local).state,'unsupported');
 assert.deepEqual(wealthEntryCapability(null,local),{state:'unsupported',realFundingEnabled:false});
});

test('an unavailable cloud service still leaves four browsable products and draft terms with no capital form',async t=>{
 let imports=0;const ui=harness({fetchImpl:async()=>({ok:false,status:503,json:async()=>{throw Error('must not parse error');}}),loadView:async()=>{imports++;throw Error();}});t.after(()=>ui.entry.destroy());
 assert.equal(ui.calls.length,0);ui.entry.render();assert.equal(ui.calls.length,0);
 assert.equal(await ui.entry.ready(),false);assert.equal(ui.entry.state().phase,'unavailable');
 for(const id of ['growth','balanced','steady','defensive']){ui.choose(id);const html=ui.entry.render();assert.match(html,new RegExp('data-wealth-entry-profile="'+id+'" aria-pressed="true"'));assert.ok(html.includes(pair('产品条款 · 候选草案','Product terms · Candidate draft')));assert.match(html,new RegExp('<button[^>]*disabled>'+pair('仅支持 BSC','BSC only')));}
 assert.equal(ui.entry.render().includes('<form'),false);assert.equal(await ui.entry.openTest(),false);assert.equal(imports,0);
 assert.deepEqual(ui.calls.map(call=>call[0]),['/api/wealth/market?asset=usdc','/api/wealth/market?asset=weth','/api/wealth/market?asset=usdc']);assert.equal(ui.calls.every(call=>call[1].method==='GET'),true);assert.equal(ui.calls[0][1].credentials,'same-origin');
});

test('a failed service read cancels its unread body on the local and public origins, even when cancelling fails, without parsing it',async t=>{
 const local='http://localhost:4215/?page=wealth',cloud='https://astarter.imstark.site/?page=wealth',oversized={'content-type':'application/json','content-length':'16385'};
 for(const [url,headers] of [[local,{}],[cloud,{}],[cloud,oversized]])for(const cancel of [()=>Promise.resolve(),()=>Promise.reject(Error('cancel failed')),()=>{throw Error('cancel failed');}]){
  let cancels=0;const ui=harness({url,fetchImpl:async()=>({ok:false,status:503,headers:{get:key=>headers[key.toLowerCase()]??null},body:{cancel(){cancels++;return cancel();},getReader(){throw Error('must not read error');}},json:async()=>{throw Error('must not parse error');}}),loadView:async()=>{throw Error();}});t.after(()=>ui.entry.destroy());
  assert.equal(await ui.entry.ready(),false);assert.equal(ui.calls.length,1);assert.equal(cancels,1);
  assert.equal(ui.entry.state().phase,'unavailable');assert.equal(ui.entry.state().capability.realFundingEnabled,false);
 }
});

test('even a syntactically valid local-test payload does not expose test funding on the public origin',async t=>{
 let imports=0;const ui=harness({loadView:async()=>{imports++;}});t.after(()=>ui.entry.destroy());
 assert.equal(await ui.entry.ready(),false);assert.equal(ui.entry.render().includes('data-wealth-entry-action="test"'),false);
 ui.action('test');await new Promise(setImmediate);assert.equal(imports,0);assert.equal(ui.calls.length,1);
});

test('duplicate checks share one GET and leaving cancels ownership of an unresolved response',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);const ui=harness({fetchImpl:()=>pending});
 const first=ui.entry.ready(),second=ui.entry.check();assert.equal(ui.calls.length,1);const signal=ui.calls[0][1].signal;
 ui.entry.leave();const before=ui.changed();assert.equal(signal.aborted,true);release(response(configuration()));
 assert.equal(await first,false);assert.equal(await second,false);assert.equal(ui.entry.state().phase,'idle');assert.equal(ui.changed(),before);assert.equal(ui.entry.state().capability.realFundingEnabled,false);ui.entry.destroy();
});

test('malformed JSON and unknown capabilities remain unavailable and can be retried',async t=>{
 let count=0;const ui=harness({url:'http://localhost:4215/?page=wealth',fetchImpl:async()=>{count++;if(count===1)return {ok:true,json:async()=>{throw Error('bad JSON');}};if(count===2)return response({capabilities:{funding:true}});return response(configuration());}});t.after(()=>ui.entry.destroy());
 assert.equal(await ui.entry.ready(),false);assert.equal(await ui.entry.check(),false);assert.equal(await ui.entry.check(),true);assert.equal(count,3);assert.equal(ui.entry.state().capability.realFundingEnabled,false);
});

test('a synchronous transport failure releases the request so retry can read the recovered service',async t=>{
 let count=0;const ui=harness({url:'http://localhost:4215/?page=wealth',fetchImpl:()=>{if(++count===1)throw Error('transport unavailable');return Promise.resolve(response(configuration()));}});t.after(()=>ui.entry.destroy());
 assert.equal(await ui.entry.ready(),false);assert.equal(await ui.entry.check(),true);assert.equal(count,2);
});

test('the test child loads only after the explicit action and is preserved across parent re-renders',async()=>{
 let imports=0,creates=0,binds=0,destroys=0;const ui=harness({url:'http://localhost:4215/?page=wealth',loadView:async()=>{imports++;return {createAIWealth:()=>{creates++;return {render:()=>'<div>test vault</div>',bind:()=>binds++,destroy:()=>destroys++};}};}});
 assert.equal(await ui.entry.ready(),true);assert.equal(imports,0);assert.equal(creates,0);
 assert.equal(await ui.entry.openTest(),true);assert.equal(imports,1);assert.equal(creates,1);assert.equal(binds,1);
 const old=ui.slot.node;old.parentNode=null;ui.host.innerHTML=ui.entry.render();ui.entry.bind();assert.equal(ui.slot.node,old);assert.equal(creates,1);
 ui.entry.leave();assert.equal(destroys,1);assert.equal(ui.entry.state().mode,'preview');ui.entry.destroy();assert.equal(destroys,1);assert.equal(ui.listeners.size,0);
});

test('a retained page rechecks its service without losing the selected product or opening a vault',async t=>{
 let imports=0;const ui=harness({url:'http://localhost:4215/?page=wealth',loadView:async()=>{imports++;}});t.after(()=>ui.entry.destroy());
 assert.equal(await ui.entry.ready(),true);ui.choose('steady');ui.entry.leave();
 assert.equal(ui.entry.state().active,false);assert.equal(ui.calls.length,1);
 ui.entry.bind();assert.equal(await ui.entry.ready(),true);
 assert.equal(ui.entry.state().selected,'steady');assert.equal(ui.entry.state().mode,'preview');
 assert.equal(ui.calls.length,2);assert.equal(imports,0);assert.equal(ui.listeners.size,1);
});

test('a late module import cannot mount a child after navigation',async()=>{
 let release,creates=0;const pending=new Promise(r=>release=r);const ui=harness({url:'http://127.0.0.1:4215/?page=wealth',loadView:()=>pending});await ui.entry.ready();
 const opened=ui.entry.openTest();ui.entry.leave();release({createAIWealth(){creates++;}});assert.equal(await opened,false);assert.equal(creates,0);assert.equal(ui.entry.state().mode,'preview');ui.entry.destroy();
});

test('child loading failure releases the local mode and never creates a success or balance',async t=>{
 const ui=harness({url:'http://localhost:4215/?page=wealth',loadView:async()=>{throw Error('load failed');}});t.after(()=>ui.entry.destroy());await ui.entry.ready();
 assert.equal(await ui.entry.openTest(),false);assert.equal(ui.entry.state().phase,'unavailable');assert.equal(ui.entry.state().mode,'preview');assert.equal(ui.entry.state().capability.realFundingEnabled,false);assert.match(ui.entry.render(),/<dd>—<\/dd>/);
});

const PUBLIC_NOW=Date.UTC(2026,10,17,12);
function publicSample(assetId='usdc'){
 return {schema:'wealth-public-market-v1',mode:'cloud-readonly',readOnly:true,realFundingEnabled:false,testFundingEnabled:false,modelEnabled:false,trackingEnabled:false,assetId,status:'observed',error:null,observation:{id:'aave-1-'+assetId+'-4660',kind:'market',status:'observed',provider:'Aave V3 · Ethereum',assetId,chainId:1,blockNumber:'4660',blockHash:'0x'+'a'.repeat(64),asOf:PUBLIC_NOW,receivedAt:PUBLIC_NOW,expiresAt:PUBLIC_NOW+300000,reserveUpdatedAt:PUBLIC_NOW,aprPercent:'4',aprBps:400,availableLiquidityUnits:'123456789000',active:true,frozen:false,paused:false,url:'https://etherscan.io/block/4660',contractUrl:'https://etherscan.io/address/0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',admission:'research_only'}};
}
const publicResponse=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
test('public origin displays a validated Aave reference without local vault imports, funding forms or model actions',async t=>{
 let imports=0;const ui=harness({now:()=>PUBLIC_NOW,fetchImpl:async()=>publicResponse(publicSample()),loadView:async()=>{imports++;}});t.after(()=>ui.entry.destroy());
 assert.equal(await ui.entry.ready(),true);assert.equal(ui.entry.state().capability.state,'cloud-readonly');assert.equal(ui.calls[0][0],'/api/wealth/market?asset=usdc');
 const html=ui.entry.render();assert.match(html,/<dd data-wealth-reference-apr>4<span>%<\/span><\/dd>/);assert.match(html,/Aave V3/);assert.match(html,/123,456\.789/);assert.match(html,/etherscan\.io\/block\/4660/);assert.match(html,/data-wealth-entry-asset="usdc"/);assert.match(html,/<dd>—<\/dd>/);
 assert.equal(html.includes('<form'),false);assert.equal(await ui.entry.openTest(),false);assert.equal(imports,0);assert.equal(ui.calls.every(call=>call[1].method==='GET'),true);
});

test('profile and asset changes abort an older public request and cannot paint a mismatched late observation',async t=>{
 let release;const pending=new Promise(resolve=>release=resolve);const ui=harness({now:()=>PUBLIC_NOW,fetchImpl:async url=>url.endsWith('usdc')?pending:publicResponse(publicSample(url.split('=').at(-1)))});t.after(()=>ui.entry.destroy());
 const old=ui.entry.ready();ui.choose('growth');assert.equal(ui.calls[0][1].signal.aborted,true);await new Promise(setImmediate);assert.equal(ui.calls.at(-1)[0],'/api/wealth/market?asset=weth');
 release(publicResponse(publicSample('usdc')));await old;assert.equal(ui.entry.state().assetId,'weth');assert.equal(ui.entry.state().observation.assetId,'weth');
 ui.chooseAsset('wbtc');await new Promise(setImmediate);assert.equal(ui.entry.state().observation.assetId,'wbtc');assert.equal(ui.calls.at(-1)[0],'/api/wealth/market?asset=wbtc');
});

test('browser history restores the product and rechecks only a different reference asset',async t=>{
 const base='https://astarter.imstark.site/?page=wealth',ui=harness({url:base+'&strategy=growth&asset=weth',now:()=>PUBLIC_NOW,fetchImpl:async url=>publicResponse(publicSample(url.split('=').at(-1)))});
 t.after(()=>ui.entry.destroy());
 await ui.entry.ready();assert.equal(ui.entry.state().observation.assetId,'weth');
 ui.visit(base+'&strategy=steady&asset=usdc');
 const restored=ui.entry.render();assert.match(restored,/data-wealth-entry-profile="steady" aria-pressed="true"/);
 assert.equal(ui.entry.state().assetId,'usdc');assert.equal(ui.entry.state().observation,null);
 ui.entry.bind();await ui.entry.ready();assert.equal(ui.entry.state().observation.assetId,'usdc');
 ui.visit(base+'&strategy=defensive&asset=weth');ui.entry.render();ui.entry.bind();
 assert.equal(ui.entry.state().selected,'defensive');assert.equal(ui.entry.state().assetId,'usdc');
 assert.equal(ui.calls.length,2);assert.equal(ui.entry.state().observation.assetId,'usdc');
});

test('links with incompatible assets reflect the displayed pair without adding a history entry',t=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'history'),changes=[];
 t.after(()=>{if(original)Object.defineProperty(globalThis,'history',original);else delete globalThis.history;});
 const state={entry:2};
 Object.defineProperty(globalThis,'history',{configurable:true,value:{state,replaceState:(kept,_,url)=>changes.push({kept,url:url.href})}});
 const ui=harness({url:'https://astarter.imstark.site/?page=wealth&strategy=defensive&asset=weth&motion=off#terms'});t.after(()=>ui.entry.destroy());
 assert.deepEqual(changes,[{kept:state,url:'https://astarter.imstark.site/?page=wealth&strategy=defensive&asset=usdc&motion=off#terms'}]);
 ui.visit(changes[0].url);ui.entry.render();assert.equal(changes.length,1);
});

test('public deadline, source expiry and leaving preserve honest unavailable state and allow a subsequent refresh',async t=>{
 let at=PUBLIC_NOW,hang=true;const ui=harness({now:()=>at,timeoutMs:15,fetchImpl:async()=>hang?new Promise(()=>{}):publicResponse(publicSample())});t.after(()=>ui.entry.destroy());
 assert.equal(await ui.entry.ready(),false);assert.equal(ui.entry.state().phase,'unavailable');hang=false;assert.equal(await ui.entry.check(),true);at+=181000;
 assert.match(ui.entry.render(),/<dd data-wealth-reference-apr>—<\/dd>/);assert.match(ui.entry.render(),new RegExp(pair('数据已过期','Data expired')));
 ui.entry.leave();assert.equal(ui.entry.state().observation,null);assert.equal(ui.entry.state().capability.realFundingEnabled,false);
});

test('wrong source asset or enabled capability fields never expose a public quote',async t=>{
 for(const value of [publicSample('weth'),{...publicSample(),realFundingEnabled:true},{...publicSample(),modelEnabled:true}]){
  const ui=harness({now:()=>PUBLIC_NOW,fetchImpl:async()=>publicResponse(value)});t.after(()=>ui.entry.destroy());assert.equal(await ui.entry.ready(),false);assert.equal(ui.entry.state().observation,null);assert.match(ui.entry.render(),/<dd data-wealth-reference-apr>—<\/dd>/);
 }
});

test('public body timeout and an aborted late response release the view without a false source',async t=>{
 let hang=true,cancelled=0;const ui=harness({now:()=>PUBLIC_NOW,timeoutMs:15,fetchImpl:async()=>hang?new Response(new ReadableStream({start(){},cancel(){cancelled++;}}),{headers:{'Content-Type':'application/json'}}):publicResponse(publicSample())});t.after(()=>ui.entry.destroy());
 assert.equal(await ui.entry.ready(),false);assert.equal(cancelled,1);assert.equal(ui.entry.state().observation,null);hang=false;assert.equal(await ui.entry.check(),true);
 let release;const late=harness({now:()=>PUBLIC_NOW,fetchImpl:()=>new Promise(resolve=>release=resolve)});t.after(()=>late.entry.destroy());const pending=late.entry.ready();late.entry.leave();assert.equal(await pending,false);release(publicResponse(publicSample()));await new Promise(setImmediate);assert.equal(late.entry.state().observation,null);assert.equal(late.entry.state().phase,'idle');
});

test('a public 429 retains product terms and an explicit retry state without local manager requests',async t=>{
 const value={...publicSample(),status:'unavailable',error:'MARKET_RATE_LIMITED',observation:null};const ui=harness({now:()=>PUBLIC_NOW,fetchImpl:async()=>new Response(JSON.stringify(value),{status:429,headers:{'Content-Type':'application/json'}})});t.after(()=>ui.entry.destroy());
 assert.equal(await ui.entry.ready(),false);assert.equal(ui.entry.state().capability.state,'cloud-readonly');assert.match(ui.entry.render(),new RegExp(pair('来源限流，稍后重试','Source rate limited. Retry shortly.')));assert.match(ui.entry.render(),/<dd data-wealth-reference-apr>—<\/dd>/);assert.equal(ui.calls.every(call=>call[0].startsWith('/api/wealth/market?asset=')),true);
});

// Card W1 pins: readable versioned terms, money precision, the T+2 calendar and the funding gates.
// They read the same candidate fixture and catalog as the tests above. A pass here is fixture evidence only.
test('every product shows readable terms with the catalog version and its own terms version',()=>{
 const pinned={growth:[30,365,'2%','20%','growth-terms-2'],balanced:[14,180,'1%','12%','balanced-terms-2'],steady:[7,90,'0.5%','8%','steady-terms-2'],defensive:[1,30,'0.1%','5%','defensive-terms-2']};
 const row=(zh,en,value)=>'<div><dt>'+pair(zh,en)+'</dt><dd>'+value+'</dd></div>';
 assert.deepEqual(catalog.profiles.map(p=>p.id),Object.keys(pinned));
 for(const p of catalog.profiles){
  const [lock,term,early,performance,version]=pinned[p.id],ui=harness({url:'https://astarter.imstark.site/?page=wealth&strategy='+p.id}),html=ui.entry.render();
  assert.match(html,new RegExp('data-wealth-entry-profile="'+p.id+'" aria-pressed="true"'));
  const terms=html.slice(html.indexOf('<details class="wealth-entry-terms"'),html.indexOf('<details class="wealth-entry-proof"'));
  for(const expected of [
   row('条款版本','Terms version',catalog.sourceVersion+' · '+version),
   row('可选资产','Assets',p.assetIds.map(id=>catalog.assets.find(a=>a.id===id).symbol).join(' / ')),
   row('封闭期 / 期限','Lock / term',lock+' / '+term+' '+pair('自然日','calendar days')),
   row('封闭期规则','Lock rule',pair('自份额确认时起算，封闭期内不可赎回','Starts at share confirmation; no redemption during the lock')),
   row('赎回付款','Redemption payout','T+2 '+pair('自然日，自赎回受理时起算','calendar days after redemption acceptance')),
   row('管理年费','Annual management fee','2%'),
   row('认购费','Subscription fee','0%'),
   row('高水位提成','High-water-mark fee',performance),
   row('提前赎回费','Early redemption fee',early+' · '+pair('到期后0%','0% at maturity')),
   row('费用顺序','Fee order',pair('每日净值计提管理费 → 新高收益提成 → 提前赎回费','Daily NAV management accrual → new-gain performance fee → early exit fee')),
   row('到期处理','At maturity',pair('赎回，不自动续期','Redeem; no automatic rollover'))
  ])assert.ok(terms.includes(expected),p.id+': '+expected);
  assert.equal(terms.split('<dt>').length-1,12);assert.ok(terms.includes(pair('产品条款 · 候选草案','Product terms · Candidate draft')));
  assert.equal(ui.calls.length,0);ui.entry.destroy();
 }
});

test('a public reference rate stays a labelled pool reference and never fills a personal value',async t=>{
 const ui=harness({now:()=>PUBLIC_NOW,fetchImpl:async()=>publicResponse(publicSample())});t.after(()=>ui.entry.destroy());
 assert.equal(await ui.entry.ready(),true);const html=ui.entry.render();
 const market=html.slice(html.indexOf('<section class="wealth-entry-market"'),html.indexOf('<details class="wealth-entry-terms"')),rest=html.replace(market,'');
 assert.match(market,/<dd data-wealth-reference-apr>4<span>%<\/span><\/dd>/);
 assert.ok(market.includes(pair('仅此借贷池的参考，不代表本产品收益。','This lending-pool reference is not the product’s return.')));
 assert.equal(rest.includes('data-wealth-reference-apr'),false);assert.equal(rest.includes('APR'),false);
 const start=rest.indexOf('<dl class="wealth-entry-balances">'),balances=rest.slice(start,rest.indexOf('</dl>',start)),unknown='<dd>'+String.fromCharCode(8212)+'</dd>';
 assert.ok(start>=0);assert.equal(balances.split(unknown).length-1,2);assert.equal(/\d/.test(balances),false);
 assert.match(rest,new RegExp('<button[^>]*disabled>'+pair('仅支持 BSC','BSC only')));
});

test('a connected wallet shows its balance without opening wealth funding',()=>{
 const address='0x'+'cd'.repeat(20);
 const ui=harness();ui.entry.destroy();
 const root=ui.root,host=ui.host;
 const entry=createWealthEntry({root,dialog:{},show(){},href:()=>'https://ipfund.art/?page=wealth',wallet:()=>({accountId:address,usdt:2.5,btc:0}),onChange(){}});
 const html=entry.render();
 assert.match(html,/0xcdcd…cdcd/);assert.match(html,/2\.5<span>USDT<\/span>/);assert.doesNotMatch(html,new RegExp(address));
 assert.match(html,/BNB Chain/);assert.match(html,/这是已连接的 BNB Chain 钱包余额|connected wallet balance on BNB Chain/);
 assert.match(html,/<button[^>]*disabled>(?:仅支持 BSC|BSC only)/);assert.match(html,/wealth-entry-fund is-empty/);
 assert.doesNotMatch(html,/真实资金暂未开放|Real funding unavailable/);
 assert.doesNotMatch(html,/尚未连接可核验的生产金库|No verified production vault/);
 entry.destroy();
});

test('a connected BNB Chain wallet with no balance grays the fund button',()=>{
 const address='0x'+'cd'.repeat(20);
 const ui=harness();ui.entry.destroy();
 const entry=createWealthEntry({root:ui.root,dialog:{},show(){},href:()=>'https://ipfund.art/?page=wealth',wallet:()=>({accountId:address,usdt:0,btc:0}),onChange(){}});
 const html=entry.render();
 assert.match(html,/BNB Chain/);assert.match(html,/wealth-entry-fund is-empty/);
 assert.match(html,/<button[^>]*disabled>(?:余额不足|No balance)/);
 assert.doesNotMatch(html,/真实资金暂未开放|Real funding unavailable/);
 entry.destroy();
});

test('money precision is pinned: base-unit asset decimals, 18-decimal shares, an Ethereum candidate chain and no vault or token address',async()=>{
 const {DAY_MS,quoteLotRedemption}=await import('./wealth-fees.mjs'),{ASSET_SPECS,parseStrategyAmount,formatStrategyUnits}=await import('./wealth-strategies.mjs'),{WEALTH_MARKET_ASSETS}=await import('./wealth-market-data.mjs');
 assert.deepEqual(catalog.assets.map(a=>[a.id,a.decimals]),[['usdc',6],['usdt',6],['weth',18],['wbtc',8]]);
 for(const a of catalog.assets)assert.deepEqual([config.assets.find(s=>s.id===a.id).decimals,ASSET_SPECS.find(s=>s.id===a.id).decimals,WEALTH_MARKET_ASSETS[a.id].decimals],[a.decimals,a.decimals,a.decimals]);
 assert.deepEqual(config.chain,{id:1,name:'Ethereum'});assert.equal(config.assets.every(a=>a.chainId===1&&a.tokenAddress===null),true);
 assert.deepEqual([config.vault.address,config.vault.spender],[null,null]);
 assert.deepEqual(catalog.profiles.map(p=>[p.strategy.custodyMode,p.strategy.fundingAuthority,p.strategy.executionAuthority].join('/')),Array(4).fill('pooled_vault/exact_deposit/vault_scoped'));
 assert.equal(parseStrategyAmount('1',6),'1000000');assert.equal(parseStrategyAmount('0.00000001',8),'1');assert.throws(()=>parseStrategyAmount('0.0000001',6),/AMOUNT/);
 // One whole share is 10^18 share units. Its value is the NAV per share, in asset base units.
 const whole=(10n**18n).toString(),lot={id:'lot-1',sharesUnits:whole,highWaterNavUnits:'1000000',unpaidManagementUnits:'0',performanceBps:0,terms:catalog.profiles.find(p=>p.id==='balanced').terms,investedAt:0};
 assert.equal(quoteLotRedemption({lot,redeemSharesUnits:whole,navPerShareUnits:'1000000',requestedAt:180*DAY_MS}).grossUnits,'1000000');
 assert.equal(formatStrategyUnits(whole,18),'1');
});

test('catalog terms follow the fee library: lock, early-redemption window, calendar T+2 and fee order',async()=>{
 const {DAY_MS,validateTerms,redemptionSchedule,redemptionFeeQuote}=await import('./wealth-fees.mjs'),friday=Date.UTC(2026,10,13,12);
 for(const {terms} of catalog.profiles){
  const unlock=terms.lockDays*DAY_MS,maturity=terms.maturityDays*DAY_MS;
  assert.equal(validateTerms(terms),terms);assert.deepEqual([terms.settlementDays,terms.dayBasis,terms.startsAt,terms.maturityAction],[2,'calendar','investment-confirmation','redeem']);
  assert.equal(redemptionSchedule(terms,0,unlock-1).locked,true);
  assert.throws(()=>redemptionFeeQuote({grossUnits:'100',highWaterValueUnits:'100',managementFeeUnits:'0',performanceBps:0,terms,investedAt:0,requestedAt:unlock-1}),/LOCKED/);
  const open=redemptionSchedule(terms,0,unlock);assert.deepEqual([open.locked,open.earlyRedemptionBps,open.settlementAt],[false,terms.earlyRedemptionBps,unlock+2*DAY_MS]);
  assert.equal(redemptionSchedule(terms,0,maturity-1).earlyRedemptionBps,terms.earlyRedemptionBps);assert.equal(redemptionSchedule(terms,0,maturity).earlyRedemptionBps,0);
  // T+2 counts calendar days: a Friday request is due on Sunday. A due time is not a payment.
  const weekend=redemptionSchedule(terms,0,friday);assert.equal(weekend.settlementAt,friday+2*DAY_MS);assert.equal(new Date(weekend.settlementAt).getUTCDay(),0);
 }
 const balanced=catalog.profiles.find(p=>p.id==='balanced'),quote=redemptionFeeQuote({grossUnits:'112000000',highWaterValueUnits:'100000000',managementFeeUnits:'2000000',performanceBps:Math.round(balanced.fees.performanceRate*10000),terms:balanced.terms,investedAt:0,requestedAt:14*DAY_MS});
 assert.deepEqual([quote.performanceFeeUnits,quote.redemptionFeeUnits,quote.netUnits,quote.nextHighWaterValueUnits],['1200000','1088000','107712000','108800000']);
 assert.equal(BigInt(quote.netUnits)+2000000n+BigInt(quote.performanceFeeUnits)+BigInt(quote.redemptionFeeUnits),112000000n);
});

test('missing terms and contracts keep every state read-only: the candidate stops at each funding gate in order',async()=>{
 const {strategyFundingGate}=await import('./wealth-strategies.mjs');
 assert.deepEqual([catalog.status,catalog.realFundingEnabled,config.status,config.liveEnabled],['candidate',false,'draft',false]);
 for(const p of catalog.profiles)for(const assetId of p.assetIds)assert.equal(strategyFundingGate(config,p.id,assetId),'CONFIG_NOT_PUBLISHED');
 const published={...structuredClone(config),status:'published'},live={...structuredClone(published),liveEnabled:true},ready=structuredClone(live),address='0x'+'1'.repeat(40);
 ready.vault.address=address;ready.vault.spender=address;ready.assets.find(a=>a.id==='usdc').tokenAddress='0x'+'2'.repeat(40);
 assert.deepEqual([published,live,ready].map(value=>strategyFundingGate(value,'balanced','usdc')),['FUNDING_DISABLED','VAULT_NOT_READY','ADAPTER_UNAVAILABLE']);
 const local='http://127.0.0.1:4215/?page=wealth',cloud='https://astarter.imstark.site/?page=wealth';
 for(const [value,href] of [[configuration(),local],[{...configuration(),config:ready},local],[{...configuration(),liveEnabled:true},local],[configuration(),cloud],[null,cloud],[publicSample(),cloud],[{...publicSample(),realFundingEnabled:true},cloud]])assert.equal(wealthEntryCapability(value,href,{now:PUBLIC_NOW}).realFundingEnabled,false);
 assert.equal(wealthEntryCapability({...configuration(),config:ready},local).state,'unsupported');
 // Browsing, AI proposals and funding are separate flags. The public origin grants browsing only.
 assert.deepEqual(wealthEntryCapability(publicSample(),cloud,{now:PUBLIC_NOW}),{state:'cloud-readonly',readOnly:true,realFundingEnabled:false,testFundingEnabled:false,modelEnabled:false,trackingEnabled:false});
});
