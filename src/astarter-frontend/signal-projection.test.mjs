import test from 'node:test';
import assert from 'node:assert/strict';
import {publicRunSignals,trackingRows,trackingRecord,signalExcerpt,signalCandleIdentity,filterSignalPreferences,signalReferenceKey,signalReferencePlan,loadSignalReferencePlan,signalQuote} from './signal-tracking.mjs';
import {hubSourceTime} from './market-hub-data.mjs';

const signal={id:'SIG-7',runId:'RUN-2',market:'ETH/USDT',side:'buy',at:10,validUntil:20,venueId:'binance',marketType:'SPOT',strategy:'S00'};
const order={id:'ORDER-9',signalId:'SIG-7',runId:'RUN-2',status:'filled',instrumentId:'binance:SPOT:ETH/USDT',accountId:'private-fixture-account'};

test('signal quote units follow the recorded instrument and never relabel USD history or infer settlement',()=>{
 const history=trackingRows(undefined,{latestOnly:true}),avax=history.find(row=>row.symbol==='AVAX'),gold=history.find(row=>row.symbol==='XAU'),index=history.find(row=>row.symbol==='SPX'),before=JSON.stringify(history);
 assert.deepEqual(signalQuote(avax),{market:null,quoteAsset:'USD',measurementUnit:null,priceUnit:'USD',settlementAsset:null});
 assert.equal(signalQuote(gold).quoteAsset,'USD');assert.equal(signalQuote(gold).measurementUnit,'盎司');assert.equal(signalQuote(index).priceUnit,'点');assert.equal(signalQuote(index).quoteAsset,null);
 for(const quote of ['USDT','USDC','BTC']){
  const record=publicRunSignals([{...signal,market:'ETH/'+quote}])[0],row={record,track:{id:'ETH',asset:{unit:'USD'}}};
  assert.equal(signalQuote(row).priceUnit,quote);assert.equal(signalQuote(row).quoteAsset,quote);assert.equal(signalQuote(row).settlementAsset,null);
 }
 assert.equal(signalQuote({record:{instrument:{}},track:{id:'BTC',asset:{unit:'USD'}}}).priceUnit,null);
 assert.equal(signalQuote({record:{instrument:{market:'BTC/USDT'}},track:{id:'BTC',asset:{unit:'USD'}}}).priceUnit,null,'normalized or defaulted instrument identity is not original price provenance');
 for(const symbol of ['SPX','XAU']){
  const record=publicRunSignals([{...signal,market:symbol+'/USDT',marketType:'PERPETUAL'}])[0],q=signalQuote({record,track:{id:symbol,asset:{unit:symbol==='SPX'?'点':'USD/盎司'}}});
  assert.equal(q.priceUnit,'USDT');assert.equal(q.measurementUnit,null);assert.equal(q.settlementAsset,null,'quote currency does not establish derivative settlement');
 }
 assert.equal(signalQuote({track:{id:'XAU',asset:{}}}).priceUnit,null,'a symbol cannot establish gold or CFD units');assert.equal(JSON.stringify(history),before);
});

test('original price provenance is preserved when an order has a different display instrument',()=>{
 const raw={...signal,price:123.45},snapshot={orders:[{...order,displayMarket:'ETH/USDC',instrumentId:'binance:SPOT:ETH/USDC'}]},before=JSON.stringify(raw),[record]=publicRunSignals([raw],snapshot);
 assert.equal(record.instrument.market,'ETH/USDC');assert.equal(record.priceMarket,'ETH/USDT');assert.equal(record.price,123.45);assert.equal(signalQuote({record}).priceUnit,'USDT');assert.equal(JSON.stringify(raw),before);
 const {row,input}=referenceFixture(),changed={...row,record:{...row.record,priceMarket:'BTC/USDC'}};
 assert.notEqual(signalReferenceKey(row),signalReferenceKey(changed));assert.equal(signalReferencePlan(changed,input).levels,null);assert.ok(signalReferencePlan(changed,input).reasons.some(reason=>reason[0].includes('报价交易对与交易标的不一致')));
 assert.equal(signalReferencePlan({...row,record:{...row.record,priceMarket:null}},input).levels,null);
});

function referenceFixture(){
 let close=100;
 const bars=Array.from({length:260},(_,i)=>{close+=i<250?.1:i<259?-.2:.9;return {time:i*300,open:close,close,high:close+1,low:close-1,volume:100};}),at=260*300000;
 const raw={id:'SIG-REF',runId:'RUN-REF',market:'BTC/USDT',side:'buy',clockKind:'wall',observedAt:at,venueId:'binance',marketType:'SPOT',strategy:'S03',strategyVersion:'s03-ema-rsi-long-flat@v1',variant:'baseline',price:500};
 const [record]=publicRunSignals([raw]),row={id:'REF',record,track:{id:'BTC',record,asset:{domain:'Crypto',unit:'USDT'},title:['买入判断','Buy assessment'],events:[]}};
 return {raw,row,bars,at,input:{bars,receivedAt:at+1000,calculatedAt:at+2000}};
}

test('strategy metadata requires explicit matching public fields and never borrows a signal revision',()=>{
 const {raw}=referenceFixture(),plan={signalId:raw.id,instanceId:raw.runId,strategy:'S03',strategyVersion:raw.strategyVersion,planVariant:'baseline'};
 const stripped={...raw,strategy:undefined,strategyVersion:undefined,variant:undefined,version:'signal-v8'};
 const [r]=publicRunSignals([stripped],{flow:{plans:[plan]}});assert.equal(r.version,'signal-v8');assert.equal(r.strategyVersion,raw.strategyVersion);assert.equal(r.variant,'baseline');assert.equal(r.strategy,'S03');
 assert.equal(publicRunSignals([stripped],{flow:{plans:[{...plan,instanceId:'OTHER'}]}})[0].strategyVersion,null);
 assert.equal(publicRunSignals([stripped],{session:{id:'OTHER',strategyVersion:raw.strategyVersion}})[0].strategyVersion,null);
 for(const patch of [{strategy:'S00'},{strategyVersion:'wrong-v1'},{planVariant:'E01'}])assert.ok(publicRunSignals([raw],{flow:{plans:[{...plan,...patch}]}})[0].strategyIssues.length);
 assert.equal(publicRunSignals([stripped],{session:{id:raw.runId,version:raw.strategyVersion}})[0].strategyVersion,null);
});

test('S03 reference uses closed original-time Wilder inputs, keeps record price and has no invented target',()=>{
 const {row,bars,at,input}=referenceFixture(),before=JSON.stringify(row),p=signalReferencePlan(row,input);
 assert.equal(p.status,'ready');assert.equal(p.levels.entry,bars.at(-1).close);assert.equal(p.evidence.metrics.atr,2);assert.equal(p.levels.stopLoss,bars.at(-1).close-4);assert.equal(p.levels.takeProfit,null);
 assert.equal(p.asOf,at);assert.equal(p.evidence.closedAt,at);assert.equal(p.provenance,'retrospective');assert.equal(p.availableAt,null);assert.equal(JSON.stringify(row),before);assert.equal(row.record.price,500);
 const future=Array.from({length:3},(_,i)=>({time:(260+i)*300,open:1000,close:1000,high:1001,low:999,volume:99999}));
 assert.deepEqual(signalReferencePlan(row,{...input,bars:[...bars,...future]}),p,'future and still-forming bars cannot change the original-time plan');
 assert.deepEqual(signalReferencePlan(row,{...input,bars:bars.slice(-250)}),p,'the same pinned 250-bar warmup produces the same reference across retrieval windows');
});

test('reference gates missing versions, unknown variants, market/direction/clock mismatches and external evidence',()=>{
 const {row,input}=referenceFixture();
 for(const patch of [{strategyVersion:null},{strategyVersion:'signal-v1'},{variant:null},{variant:'unknown'},{variant:'E01'},{direction:'sell'},{clockKind:'simulation'},{strategyIssues:['strategyVersion']},{instrument:{...row.record.instrument,market:'ETH/USDT'}},{instrument:{...row.record.instrument,venue:'okx'}},{instrument:{...row.record.instrument,marketType:'PERPETUAL'}}]){
  const p=signalReferencePlan({...row,record:{...row.record,...patch}},input);assert.equal(p.levels,null,JSON.stringify(patch));assert.ok(p.reasons.length);
 }
 for(const [strategy,symbol]of [['S00','BTC'],['RX03-S','ETH']]){
  const p=signalReferencePlan({...row,record:{...row.record,strategy,strategyVersion:'research-v0.1',instrument:{...row.record.instrument,symbol,market:symbol+'/USDT'}}},input);
  assert.equal(p.levels,null);assert.ok(p.reasons.some(reason=>/评分|登记池/.test(reason[0])));assert.ok(p.rules.stop);assert.ok(p.rules.target);
 }
});

test('reference rejects gaps, invalid bars, warmup, missing original close and invalid receipt times',()=>{
 const {row,bars,input}=referenceFixture();
 for(const patch of [{bars:bars.slice(0,249)},{bars:bars.slice(0,-1)},{bars:bars.filter((_,i)=>i!==20)},{bars:bars.map((b,i)=>i===100?{...b,high:0}:b)},{receivedAt:null},{receivedAt:input.calculatedAt+1}]){
  const p=signalReferencePlan(row,{...input,...patch});assert.equal(p.levels,null);assert.equal(p.status,'pending');assert.ok(p.reasons.length);
 }
 const down=bars.map((b,i)=>({...b,open:200-i*.1,close:200-i*.1,high:201-i*.1,low:199-i*.1})),p=signalReferencePlan(row,{...input,bars:down});
 assert.equal(p.status,'not-triggered');assert.equal(p.levels,null);assert.ok(p.evidence.checks.some(check=>check.value===false));
});

test('reference loader makes one existing candle request, validates receipt age and never polls',async()=>{
 const {row,bars,at}=referenceFixture(),rawBars=bars.map(b=>[b.time*1000,b.open,b.high,b.low,b.close,b.volume,(b.time+300)*1000-1]);let calls=0;
 const fetchImpl=async(url,options)=>{calls++;assert.equal(url,'/api/market-hub?resource=candles&symbol=BTCUSDT&interval=5m');assert.equal(options.credentials,'omit');return {ok:true,json:async()=>({body:rawBars,receivedAt:at+1000})};};
 const p=await loadSignalReferencePlan(row,{fetchImpl,now:()=>at+2000});assert.equal(p.status,'ready');assert.equal(calls,1);
 assert.equal((await loadSignalReferencePlan(row,{fetchImpl,now:()=>at+40000})).status,'pending');
 const missing={...row,record:{...row.record,strategyVersion:null}};await loadSignalReferencePlan(missing,{fetchImpl});assert.equal(calls,2);
 const failed=await loadSignalReferencePlan(row,{fetchImpl:async()=>{throw Error('offline');}});assert.equal(failed.status,'error');assert.match(failed.reasons[0][0],/重试/);
 const invalid=await loadSignalReferencePlan(row,{fetchImpl:async()=>({ok:true,json:async()=>({body:[],receivedAt:at+1000})}),now:()=>at+2000});assert.equal(invalid.status,'pending');assert.doesNotMatch(invalid.reasons[0][0],/重试|重新打开/);
});

test('page reference, copy, HTML and assistant excerpt retain the same retrospective provenance',async()=>{
 const {row,input}=referenceFixture(),referencePlan=signalReferencePlan(row,input),selected={...row,referencePlan},before=JSON.stringify(row);
 const {signalCopyText,signalReportHTML}=await import('./signal-tracking-view.mjs');
 for(const output of [signalCopyText(selected),signalReportHTML(selected)]){assert.match(output,/回看计算|Retrospective/);assert.match(output,/未知|Unknown/);assert.ok(output.includes('s03-ema-rsi-long-flat@v1'));assert.ok(output.includes('500 USDT'));assert.match(output,/条件退出|Conditional exit/);assert.match(output,/closed-market-v3/);}
 assert.match(signalCopyText(selected),/ATR 14: 2 USDT/);assert.match(signalCopyText(selected),/RSI 14 · 0–100:/);
 assert.deepEqual(JSON.parse(signalExcerpt(selected)).referencePlan,referencePlan);assert.equal(JSON.stringify(row),before);
 const other={...row,record:{...row.record,signalId:'OTHER'},referencePlan};assert.equal(JSON.parse(signalExcerpt(other)).referencePlan.levels,null,'a result from another signal is not adopted');
});

test('a detached or superseded reference request cannot populate another signal',async t=>{
 const {createSignalTracker}=await import('./signal-tracking-view.mjs'),{raw,row,input}=referenceFixture(),saved={document:globalThis.document,localStorage:globalThis.localStorage,location:globalThis.location,matchMedia:globalThis.matchMedia};
 t.after(()=>{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 globalThis.document={body:{append(){}},createElement:()=>({setAttribute(){},addEventListener(){}})};globalThis.localStorage={getItem:()=>null};globalThis.location={search:'?page=signals'};globalThis.matchMedia=()=>({matches:false});
 const recordId=r=>[r.sourceId,r.version,r.runId,r.signalId].join(':'),hostFor=r=>({isConnected:true,innerHTML:'',dataset:{signalReference:signalReferenceKey(r),signalReferenceId:recordId(r.record)},querySelectorAll:()=>[],querySelector:()=>null});
 const a=hostFor(row),secondRaw={...raw,id:'SIG-SECOND'},second={...row,record:publicRunSignals([secondRaw])[0]},b=hostFor(second);let hosts=[a];const pending=[];
 const open={dataset:{trackOpen:recordId(second.record)}},root={contains:host=>hosts.includes(host),querySelector:()=>null,querySelectorAll:selector=>selector==='[data-signal-reference]'?hosts:selector==='[data-track-open]'?[open]:[]},w={s:{signals:[raw],aiSignalWatch:[]},touch(){throw Error('No business mutation');}};
 const view=createSignalTracker({w,root,refresh(){},loadReference:(row,options)=>new Promise(resolve=>pending.push({row,options,resolve}))});
 view.render({nav:''});view.bind();assert.equal(pending.length,1);assert.match(a.innerHTML,/正在核算|Calculating/);const loadingA=a.innerHTML;
 a.isConnected=false;hosts=[b];w.s.signals=[secondRaw];view.render({nav:''});view.bind();assert.equal(pending.length,2);assert.equal(pending[0].options.signal.aborted,true);const loadingB=b.innerHTML;
 pending[0].resolve(signalReferencePlan(row,input));await new Promise(resolve=>setImmediate(resolve));assert.equal(a.innerHTML,loadingA);assert.equal(b.innerHTML,loadingB);
 pending[1].resolve(signalReferencePlan(second,input));await new Promise(resolve=>setImmediate(resolve));assert.match(b.innerHTML,/参考入场|Reference entry/);assert.equal(view.sourceSnapshot(),null,'the removed selection is not silently replaced');open.onclick();assert.equal(JSON.parse(view.sourceSnapshot().text).signalId,'SIG-SECOND');assert.equal(JSON.parse(view.sourceSnapshot().text).referencePlan.status,'ready');
});

test('a network error retries in place once, disables repeated clicks and preserves the signal and business state',async t=>{
 const {createSignalTracker}=await import('./signal-tracking-view.mjs'),{raw,row,input}=referenceFixture(),saved={document:globalThis.document,localStorage:globalThis.localStorage,location:globalThis.location};
 t.after(()=>{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 globalThis.document={body:{append(){}},createElement:()=>({setAttribute(){},addEventListener(){}})};globalThis.localStorage={getItem:()=>null};globalThis.location={search:'?page=signals'};
 const recordId=[row.record.sourceId,row.record.version,row.record.runId,row.record.signalId].join(':'),retry={closest:()=>host},host={isConnected:true,innerHTML:'',dataset:{signalReference:signalReferenceKey(row),signalReferenceId:recordId},querySelector:()=>null,querySelectorAll:selector=>selector==='[data-track-reference-retry]'&&host.innerHTML.includes('data-track-reference-retry')?[retry]:[]};
 const cardAdvice={dataset:{signalAction:recordId,signalActionKey:signalReferenceKey(row)},textContent:''},root={contains:e=>e===host,querySelector:()=>null,querySelectorAll:selector=>selector==='[data-signal-reference]'?[host]:selector==='[data-signal-action]'?[cardAdvice]:[]},w={s:{signals:[raw],credits:600,aiSignalWatch:[]},touch(){throw Error('No business mutation');}},pending=[];
 const view=createSignalTracker({w,root,refresh(){throw Error('Retry must stay in place');},loadReference:(row,options)=>new Promise(resolve=>pending.push({row,options,resolve}))}),before=JSON.stringify(w.s);
 view.render({nav:''});view.bind();assert.match(cardAdvice.textContent,/等待核算完成/);pending[0].resolve({...signalReferencePlan(row),status:'error',reasons:[['网络请求失败','Network request failed']]});await new Promise(resolve=>setImmediate(resolve));assert.match(host.innerHTML,/重试核算|Retry calculation/);assert.match(cardAdvice.textContent,/重试核算/);
 const click=retry.onclick;click();click();assert.equal(pending.length,2);assert.match(host.innerHTML,/data-track-reference-retry disabled aria-busy="true"/);assert.match(host.innerHTML,/正在核算|Calculating/);assert.equal(pending[1].row.record.signalId,row.record.signalId);
 pending[1].resolve(signalReferencePlan(row,input));await new Promise(resolve=>setImmediate(resolve));assert.match(host.innerHTML,/参考入场|Reference entry/);assert.doesNotMatch(host.innerHTML,/data-track-reference-retry/);assert.match(cardAdvice.textContent,/回看价格条件满足.*复核当前条件/);assert.equal(JSON.parse(view.sourceSnapshot().text).referencePlan.status,'ready');assert.equal(JSON.stringify(w.s),before);
});

test('public signals retain provenance and omit account state from every excerpt',()=>{
 const raw={...signal,sourceId:'AI-7',sourceType:'autonomous',version:3,accountId:'private-fixture-account',address:'private-fixture-address',balance:123456,position:{quantity:42},secret:'private-fixture-secret',description:'private-fixture-description'};
 const before=JSON.stringify(raw),[record]=publicRunSignals([raw],{time:12});
 assert.equal(record.sourceId,'AI-7');assert.equal(record.sourceType,'autonomous');assert.equal(record.version,'3');assert.equal(record.validity,'active');assert.equal(record.stage,'analysis');
 assert.doesNotMatch(signalExcerpt({record}),/private-fixture|123456|quantity|balance|description|secret/);
 assert.equal(JSON.stringify(raw),before);assert.deepEqual(publicRunSignals([null,{...raw,id:'bad id'},{...raw,market:'ETH<script>'}]),[]);
});

test('order labels require matching run and positive confirmed fill records',()=>{
 const snapshot={time:12,orders:[order],flow:{fills:[]}};
 assert.equal(publicRunSignals([signal],snapshot)[0].stage,'submitted');
 for(const fill of [{orderId:'wrong',quantity:1},{orderId:order.id,quantity:0},{orderId:order.id,quantity:'Infinity'},{orderId:order.id,quantity:1,accountId:'other'},{orderId:order.id,quantity:1,instrumentId:'other'}]){
  snapshot.flow.fills=[fill];assert.equal(publicRunSignals([signal],snapshot)[0].stage,'submitted');
 }
 snapshot.flow.fills=[{orderId:order.id,quantity:'0.1',accountId:order.accountId,instrumentId:order.instrumentId}];
 assert.equal(publicRunSignals([signal],snapshot)[0].stage,'confirmed-fill');
 assert.equal(publicRunSignals([{...signal,runId:'OTHER'}],snapshot)[0].stage,'analysis');
 assert.equal(publicRunSignals([signal],{...snapshot,orders:[{...order,status:'rejected'}],flow:{fills:[]}})[0].stage,'submitted');
});

test('public signals preserve explicit market profile and chain without exposing account fields',()=>{
 const raw={...signal,venueId:'uniswap',profileId:'dex-spot',chainId:1,accountId:'private-fixture-account',wallet:'private-fixture-wallet'};
 const [record]=publicRunSignals([raw]);assert.equal(record.instrument.profileId,'dex-spot');assert.equal(record.instrument.chainId,'1');
 const snapshot={orders:[{...order,profileId:'dex-perp',chainId:'42161'}],flow:{plans:[{signalId:signal.id,instanceId:signal.runId,profileId:'dex-spot',chainId:'8453'}]}};
 assert.equal(publicRunSignals([raw],snapshot)[0].instrument.chainId,'8453');
 assert.equal(publicRunSignals([raw],{orders:snapshot.orders})[0].instrument.profileId,'dex-perp');
 assert.equal(publicRunSignals([raw],{orders:snapshot.orders})[0].instrument.chainId,'42161');
 for(const chainId of [undefined,null,false,0,-1,1.5,Infinity,NaN,'01','0x1','1e3','1.5',' 1','9007199254740992',{},[]])assert.equal(publicRunSignals([{...raw,chainId}])[0].instrument.chainId,null,String(chainId));
 for(const profileId of [null,{},'bad value','private-secret','private-fixture-account','0x'+'a'.repeat(40)])assert.equal(publicRunSignals([{...raw,profileId}])[0].instrument.profileId,null);
 assert.doesNotMatch(signalExcerpt({record}),/private-fixture|accountId|wallet/);
 assert.equal(publicRunSignals([signal])[0].instrument.profileId,null);assert.equal(publicRunSignals([signal])[0].instrument.chainId,null);
});

test('canonical instrument metadata is recovered only when it matches the recorded market and explicit fields',()=>{
 const raw={...signal,venueId:undefined,marketType:undefined};
 const snapshot={orders:[order]};
 const [record]=publicRunSignals([raw],snapshot);assert.equal(record.instrument.venue,'binance');assert.equal(record.instrument.marketType,'SPOT');
 assert.equal(record.instrument.profileId,null);assert.equal(record.instrument.chainId,null);
 for(const instrumentId of ['binance:SPOT:BTC/USDT','binance:SPOT:ETH/USDT:account','binance:1:SPOT:ETH/USDT','private-secret:SPOT:ETH/USDT','binance:UNKNOWN:ETH/USDT']){
  const [invalid]=publicRunSignals([{...raw,instrumentId}]);assert.equal(invalid.instrument.venue,null,instrumentId);assert.equal(invalid.instrument.marketType,null,instrumentId);
 }
 assert.equal(publicRunSignals([raw])[0].instrument.marketType,null,'unknown is never guessed from an asset');
 assert.equal(publicRunSignals([{...raw,venueId:'okx'}],snapshot)[0].instrument.marketType,null,'conflicting venue cannot borrow the canonical type');
 assert.equal(publicRunSignals([{...raw,marketType:'PERPETUAL'}],snapshot)[0].instrument.venue,null,'conflicting type cannot borrow the canonical venue');
 const plan={signalId:signal.id,instanceId:signal.runId,instrumentId:'uniswap:SPOT:WETH/USDC'};
 const [dex]=publicRunSignals([raw],{flow:{plans:[plan]}});assert.equal(dex.instrument.market,'WETH/USDC');assert.equal(dex.instrument.venue,'uniswap');assert.equal(dex.instrument.marketType,'SPOT');
});

test('validity follows its own clock, never becomes active without a deadline, and survives deduplication',t=>{
 t.mock.method(Date,'now',()=>1000);
 assert.equal(publicRunSignals([signal],{time:19})[0].validity,'active');
 assert.equal(publicRunSignals([signal],{time:20})[0].validity,'expired');
 assert.equal(publicRunSignals([{...signal,status:'expired'}],{time:1})[0].validity,'expired');
 assert.equal(publicRunSignals([{...signal,validUntil:undefined}],{time:12})[0].validity,'unknown');
 assert.equal(publicRunSignals([signal],{})[0].validity,'unknown');
 assert.equal(publicRunSignals([{...signal,clockKind:'wall',validUntil:999}],{time:1})[0].validity,'expired');
 const invalid=publicRunSignals([{...signal,clockKind:'wall',at:1e20,validUntil:1e20}])[0];assert.equal(invalid.observedAt,null);assert.equal(invalid.validUntil,null);
 assert.equal(publicRunSignals([signal,signal,{...signal,runId:'RUN-3'}],{time:12}).length,2);
});

test('execution metadata identifies autonomous signals and excludes manual orders',()=>{
 const plan={signalId:signal.id,instanceId:signal.runId,executionKind:'AI_AUTO',venueId:'binance',marketType:'SPOT'};
 assert.equal(publicRunSignals([signal],{flow:{plans:[plan]}})[0].sourceType,'autonomous');
 assert.deepEqual(publicRunSignals([signal],{flow:{plans:[{...plan,executionKind:'MANUAL'}]}}),[]);
 assert.deepEqual(publicRunSignals([signal],{session:{id:signal.runId,singleShot:true}}),[]);
});

test('signal candles require the same venue, market and instrument type',()=>{
 const [record]=publicRunSignals([signal],{time:12}),row={record,track:{id:'ETH',asset:{domain:'Crypto'},record}};
 assert.equal(signalCandleIdentity(row).market,'ETH/USDT');
 const btc={track:{id:'BTC',source:'market',asset:{domain:'Crypto'},record:{strategy:'RX03-S'}}};assert.equal(filterSignalPreferences([btc],{strategy:'S00'}).length,0);assert.equal(filterSignalPreferences([btc],{strategy:'RX03-S'}).length,1);
 for(const patch of [{venue:null},{venue:'okx'},{marketType:'PERPETUAL'},{market:'ETH/USDC'}])assert.equal(signalCandleIdentity({...row,record:{...record,instrument:{...record.instrument,...patch}}}),null);
 const history=trackingRows(undefined,{asset:'ETH',latestOnly:true})[0],frozen=trackingRecord(history);
 assert.equal(frozen.plan,null);assert.equal(signalReferencePlan(history).levels,null);assert.equal(frozen.clockKind,'historical');assert.equal(frozen.validity,'historical');assert.equal(frozen.stage,'analysis');assert.match(frozen.observedAt,/T\d\d:\d\d:00\+08:00$/);
});

test('daily sources keep dates while timestamp sources keep their observed time',()=>{
 const at=Date.parse('2026-11-06T00:00:00Z');
 for(const key of ['stablecoins','tvl','sentiment'])assert.equal(hubSourceTime(at,key),'2026-11-06');
 assert.equal(hubSourceTime(at,'assets'),'2026-11-06 08:00:00 UTC+8');
 for(const value of [null,undefined,'',NaN,Infinity,1e20,8.64e15,'not-a-date'])assert.equal(hubSourceTime(value,'assets'),'—');
});

test('copy and readable report preserve public identity without account state or executable content',async t=>{
 const {createSignalTracker}=await import('./signal-tracking-view.mjs'),saved={document:globalThis.document,navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator'),localStorage:globalThis.localStorage,location:globalThis.location};
 const buttons={copy:{dataset:{}},export:{dataset:{}}},origin={value:'all',addEventListener(type,handler){this['on'+type]=handler;}},feedback={},dialog={setAttribute(){},addEventListener(){}},w={s:{signals:[{...signal,accountId:'private-fixture-account',secret:'private-fixture-secret',balance:123456}],aiSignalWatch:[]},touch(){throw Error('read only');}},root={querySelector:s=>s==='[data-track-feedback]'?feedback:s==='[data-track-origin]'?origin:null,querySelectorAll:s=>s==='[data-track-copy]'?[buttons.copy]:s==='[data-track-export]'?[buttons.export]:[]};
 let clipboard='',downloaded='',blob;
 try{
  globalThis.document={body:{append(){}},createElement:tag=>tag==='dialog'?dialog:{click(){downloaded=this.download;}}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>{clipboard=text;}}}});
  globalThis.localStorage={getItem:()=>null};globalThis.location={search:'?page=signals'};
  t.mock.method(URL,'createObjectURL',value=>{blob=value;return 'blob:test';});t.mock.method(URL,'revokeObjectURL',()=>{});
  const tracker=createSignalTracker({w,root,refresh(){},readSnapshot:()=>({time:12})});tracker.bind();origin.value='bot';origin.onchange({target:origin});const html=tracker.render({nav:''}),id=html.match(/data-track-copy="([^"]+)"/)[1];
  buttons.copy.dataset.trackCopy=id;buttons.export.dataset.trackExport=id;tracker.bind();const before=JSON.stringify(w.s);
  await buttons.copy.onclick();await buttons.export.onclick();
  const report=await blob.text();assert.equal(blob.type,'text/html;charset=utf-8');assert.match(report,/^<!doctype html>/i);assert.equal(downloaded,'Astarter-ETH-SIG-7-report.html');
  for(const value of ['ETH','SIG-7','RUN-2']){assert.ok(clipboard.includes(value),value);assert.ok(report.includes(value),value);}
  assert.throws(()=>JSON.parse(clipboard));assert.doesNotMatch(report,/<script\b|<iframe\b|\bon(?:load|click|error)\s*=/i);
  assert.doesNotMatch(clipboard+report,/private-fixture|123456|accountId|secret/);assert.equal(JSON.stringify(w.s),before);
  const snapshot=JSON.parse(tracker.sourceSnapshot().text);assert.equal(snapshot.signalId,signal.id);assert.equal(snapshot.runId,signal.runId);assert.doesNotMatch(tracker.sourceSnapshot().text,/private-fixture|123456|accountId|secret/);
 }finally{
  for(const key of ['document','localStorage','location']){if(saved[key]===undefined)delete globalThis[key];else globalThis[key]=saved[key];}
  if(saved.navigator)Object.defineProperty(globalThis,'navigator',saved.navigator);else delete globalThis.navigator;
 }
});
