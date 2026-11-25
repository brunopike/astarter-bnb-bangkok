import {EXCHANGE_OPERATIONS,readAssistantQuotes,cleanAssistantQuote} from './assistant-exchange-data.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {captureMarketWindow} from './trading-chart-data.mjs';
import {analyzeBars,extractMaterial,addSource,normalizeChatStore,questionTopic,questionLanguage,questionQuoteSymbols,technicalIntent,CHAT_LIMITS,BINANCE_AGENT_OS,ASSISTANT_TOOLSETS,normalizeResearchConfig,researchAssets,researchRange,researchDate,RESEARCH_AS_OF,buildResearchReport,normalizeResearchReport,technicalContext,cleanSharedOutput,encodeSharedOutput,decodeSharedOutput,sharedOutputURL,socialDraft} from './assistant-analysis.mjs';
import {withLocale} from './locale.mjs';import {assistantBars,createTradingAssistant} from './trading-assistant.mjs';
import {MARKET} from './data-center-fixtures.mjs';
const bars=values=>values.map((close,i)=>({open:i?values[i-1]:close,close,high:Math.max(close,i?values[i-1]:close)+1,low:Math.min(close,i?values[i-1]:close)-1,time:i*3600000}));
test('saved market analysis preserves its real source, period and exact OHLCV window',()=>{
 const at=1_800_000_000_000,now=at+9_000_000,data=Array.from({length:10},(_,i)=>({time:at/1000+i*900,open:100,high:105,low:98,close:102,volume:12}));
 const snap=captureMarketWindow({market:'ETH/USDT',period:'15m'},data,{from:1,to:8},{state:'live',asOf:now},now),technical={...snap,...analyzeBars(snap.bars),asset:'ETH'};
 const input={schema:1,active:'T',threads:[{id:'T',mode:'technical',asset:'ETH',period:'15m',turns:[{id:'A',question:'Read this window',mode:'technical',technical}]}]},saved=normalizeChatStore(input).threads[0];
 assert.equal(saved.period,'15m');assert.equal(saved.turns[0].technical.period,'15m');assert.equal(saved.turns[0].technical.clockKind,'wall');assert.equal(saved.turns[0].technical.provider,'Binance Spot');assert.equal(saved.turns[0].technical.market,'ETH/USDT');assert.equal(saved.turns[0].technical.asOf,now);assert.deepEqual(saved.turns[0].technical.bars,snap.bars);
 technical.bars[0].close=104;assert.equal(saved.turns[0].technical.bars[0].close,102);
 assert.equal(normalizeChatStore({...input,threads:[{...input.threads[0],turns:[{...input.threads[0].turns[0],technical:{...technical,market:'BTC/USDT'}}]}]}).threads[0].turns[0].technical,null);
});
test('current crypto analysis without a ready chart cannot bill or replace a saved report',async()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage},storage=new Map(),nodes=new Map(),key='hive.trading-assistant.v1',input={value:''},notices=[];let billed=0;
 const node=s=>{if(!nodes.has(s))nodes.set(s,{addEventListener(type,fn){this[type]=fn;}});return nodes.get(s);};
 const root={querySelector:s=>s==='[data-chat-input]'?input:s==='[data-trading-chart="assistant-market"]'?null:s==='.chat-feed'?{scrollTop:0}:s==='.chat-turn:last-child'?null:node(s),querySelectorAll:()=>[]};
 storage.set(key,JSON.stringify({schema:1,active:'T',threads:[{id:'T',mode:'technical',asset:'BTC',period:'15m',chartOpen:true,turns:[]}]}));
 try{globalThis.document={addEventListener(){}};globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const assistant=createTradingAssistant({root,refresh(){},go(){},notify:text=>notices.push(text),context:()=>({}),account:{s:{scopeType:'personal',tasks:[]},subscribe(){},runTask(){billed++;}}});assistant.bind();await node('[data-chat-analyze]').click();
  assert.equal(billed,0);assert.equal(JSON.parse(storage.get(key)).threads[0].turns.length,0);assert.equal(notices.length,1);
 }finally{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});
test('analyzing historical bars delivers a free example and retains the earlier record',async()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage},storage=new Map(),nodes=new Map(),input={value:'Read this window',focus(){}},key='hive.trading-assistant.v1';
 const node=s=>{if(!nodes.has(s))nodes.set(s,{addEventListener(type,fn){this[type]=fn;}});return nodes.get(s);};
 const root={querySelector:s=>s==='[data-chat-input]'?input:s==='[data-trading-chart="assistant-market"]'?null:s==='[data-chart="assistant-window"]'?{dataset:{rangeStart:'10',visibleCount:'30'}}:s==='.chat-feed'?{scrollTop:0}:s==='.chat-turn:last-child'?null:node(s),querySelectorAll:()=>[]};
 const sample=assistantBars(MARKET.find(a=>a.symbol==='XAU')).slice(-30),previous={id:'old',mode:'technical',question:'Earlier analysis',technical:{...analyzeBars(sample),asset:'XAU',period:'1H',bars:sample}};
 storage.set(key,JSON.stringify({schema:1,active:'T',threads:[{id:'T',mode:'technical',asset:'XAU',period:'1H',chartOpen:true,turns:[previous]}]}));
 try{globalThis.document={addEventListener(){}};globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const assistant=createTradingAssistant({root,refresh(){},go(){},notify(){},context:()=>({}),account:{s:{scopeType:'personal',tasks:[]},subscribe(){},runTask(){assert.fail('Historical bars must not request a quote');}}});assistant.bind();await node('[data-chat-analyze]').click();
  const thread=JSON.parse(storage.get(key)).threads[0],last=thread.turns.at(-1);
  assert.equal(thread.turns.length,2);assert.equal(thread.turns[0].id,'old');assert.equal(last.technical.clockKind,'historical');assert.equal(last.technical.count,30);
  assert.equal(last.billingJob,undefined);assert.match(assistant.render(),/免费历史示例|Free historical example/);assert.match(assistant.render(),/Read this window/);
 }finally{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});
test('public quote snapshots check the exact instrument and source time independently of relay receipt time',async()=>{
 const now=1_800_000_000_000,receivedAt=now-50,asOf=now-6000,at=()=>now;
 const ticker=(symbol,closeTime)=>({symbol,lastPrice:'101',openPrice:'100',quoteVolume:'1000',closeTime});
 const responses={tickers:[ticker('BTCUSDT',now-3600000),ticker('ETHUSDT',asOf),ticker('DOGEUSDT',asOf)],
  'gold-spot':{source:'Gold API',symbol:'XAU',currency:'USD',unit:'USD/troy oz',price:1200,asOf}};
 const calls=[];
 const fetchImpl=async(url,init)=>{
  calls.push(url);assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');assert.ok(init.signal);
  const resource=new URL(url,'http://localhost').searchParams.get('resource');
  return Response.json({schema:'public-market-relay-v1',resource,receivedAt,body:responses[resource]});
 };
 const [eth,btc,sol,gold]=await readAssistantQuotes(['ETH','BTC','SOL','XAU'],{fetchImpl,now:at});
 assert.deepEqual(calls.sort(),['/api/market-hub?resource=gold-spot','/api/market-hub?resource=tickers']);
 assert.equal(eth.state,'observed');assert.equal(eth.market,'ETH/USDT');assert.equal(eth.source,'Binance Spot');assert.equal(eth.price,101);assert.equal(eth.asOf,asOf);
 assert.equal(btc.state,'stale');assert.equal(btc.price,undefined);assert.equal(btc.asOf,now-3600000);assert.equal(sol.state,'unavailable');
 assert.equal(gold.market,'XAU/USD');assert.equal(gold.asOf,asOf);assert.equal(gold.unit,'USD/troy oz');
 assert.equal(cleanAssistantQuote({...eth,market:'BTC/USDT'}).state,'unavailable');
 assert.equal(cleanAssistantQuote({...eth,source:'Example'}).state,'unavailable');
 const [offline]=await readAssistantQuotes(['ETH'],{now:at,fetchImpl:async()=>new Response(null,{status:503})});
 assert.deepEqual(offline,{symbol:'ETH',state:'unavailable'});
 const controller=new AbortController(),hung=readAssistantQuotes(['ETH'],{now:at,signal:controller.signal,fetchImpl:async()=>({ok:true,text:()=>new Promise(()=>{})})});
 await Promise.resolve();controller.abort();assert.deepEqual(await hung,[offline]);
});
test('ordinary chat delivers free examples and current quotes through the composer, and restores the original price and time',async t=>{
 const storage=new Map(),nodes=new Map(),key='hive.trading-assistant.v1',input={value:'',focus(){}};
 const saved={document:globalThis.document,localStorage:globalThis.localStorage};
 t.after(()=>{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 globalThis.document={body:{dataset:{page:'assistant'}},addEventListener(){},querySelector(){return null;}};
 globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 const root={
  querySelector(s){
   if(s==='[data-chat-input]')return input;
   if(['.chat-feed','.chat-turn:last-child','[data-chart="assistant-window"]'].includes(s))return null;
   if(!nodes.has(s))nodes.set(s,{focus(){},addEventListener(){}});
   return nodes.get(s);
  },
  querySelectorAll:()=>[]
 };
 let billings=0;const calls=[],sourceAt=Date.now()-4500;
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  calls.push(url);assert.equal(init.credentials,'omit');
  return Response.json({schema:'public-market-relay-v1',resource:'tickers',receivedAt:Date.now(),body:[{symbol:'ETHUSDT',lastPrice:'2501',openPrice:'2500',quoteVolume:'30000',closeTime:sourceAt}]});
 });
 const options={root,account:{s:{scopeType:'personal',tasks:[]},subscribe(){},runTask(){billings++;}},refresh(){},go(){},notify(){},context:()=>({})};
 const assistant=createTradingAssistant(options);
 const ask=async text=>{assistant.bind();input.value=text;input.oninput();await root.querySelector('.chat-composer').onsubmit({preventDefault(){}});};
 const read=()=>JSON.parse(storage.get(key)).threads[0].turns;
 await ask('你好');await ask('限价单和市价单有什么区别？');
 assert.equal(calls.length,0);assert.match(assistant.render(),/免费示例|Free example/);assert.doesNotMatch(assistant.render(),/2026-10-24/);
 await ask('以太坊现在市价多少？');
 assert.deepEqual(calls,['/api/market-hub?resource=tickers']);assert.equal(billings,0);assert.ok(read().every(t=>!t.billingJob));
 const quote=read().at(-1).quotes[0];assert.equal(quote.symbol,'ETH');assert.equal(quote.asOf,sourceAt);assert.equal(quote.price,2501);
 const fresh=createTradingAssistant(options).render();
 assert.match(fresh,/ETH\/USDT/);assert.match(fresh,/Binance Spot/);assert.match(fresh,/2,501.00 USDT/);assert.match(fresh,/来源时间|Source time/);assert.doesNotMatch(fresh,/2026-10-24/);
 assert.equal(calls.length,1);
 await ask('SOL/USDT 现在多少钱？');
 const missed=read().at(-1);assert.deepEqual(missed.quotes,[{symbol:'SOL',state:'unavailable'}]);assert.ok(!missed.billingJob);
 assert.match(assistant.render(),/没有返回这个标的的有效报价|no verified quote/);assert.equal(billings,0);
 assert.deepEqual(questionQuoteSymbols('市场行情怎么样？'),['BTC','ETH','SOL']);assert.deepEqual(questionQuoteSymbols('ETH/USDC 现价？'),[]);assert.deepEqual(questionQuoteSymbols('BTCUSDT 走势与风险？','risk'),['BTC']);
});
test('technical summary uses exactly the selected candles, including flat RSI and open-to-close return',()=>{
 const all=bars(Array.from({length:40},(_,i)=>100+i)),r=analyzeBars(all.slice(10,30));
 assert.equal(r.count,20);assert.equal(r.open,109);assert.equal(r.close,129);assert.equal(r.low,108);assert.equal(r.high,130);assert.equal(r.ma5,127);assert.equal(r.ma20,119.5);assert.equal(r.rsi,100);assert.equal(r.trend,'rising');
 assert.equal(analyzeBars(bars(Array(20).fill(100))).rsi,50);
 assert.equal(analyzeBars(bars(Array.from({length:20},(_,i)=>100-i))).rsi,0);
 assert.throws(()=>analyzeBars(all.slice(0,7)));assert.throws(()=>analyzeBars([{...all[0],high:0},...all.slice(1)]));
});
test('Wilder RSI uses smoothing after the first 14 changes',()=>{
 const values=[44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28,46.00];
 assert.ok(Math.abs(analyzeBars(bars(values)).rsi-66.2496)<.001);
});
test('4H chart aggregation preserves hourly OHLC bounds, timestamps and the latest shared quote',()=>{
 const a=MARKET.find(a=>a.symbol==='ETH'),hourly=assistantBars(a,'1H'),four=assistantBars(a,'4H');
 assert.equal(hourly.length,168);assert.equal(four.length,42);assert.equal(four.at(-1).close,a.price);
 for(let i=0;i<four.length;i++){const input=hourly.slice(i*4,i*4+4),bar=four[i];assert.equal(bar.open,input[0].open);assert.equal(bar.close,input[3].close);assert.equal(bar.time,input[3].time);assert.equal(bar.high,Math.max(...input.map(b=>b.high)));assert.equal(bar.low,Math.min(...input.map(b=>b.low)));}
 const summary=analyzeBars(four.slice(7,35));assert.equal(summary.count,28);assert.equal(summary.end,four[34].time);
});
test('material extraction keeps citations and does not turn transfers into trades',()=>{
 const s=[{id:'a',title:'原文',text:'ETH 地址转出 240 ETH。所有者未知。'},{id:'b',title:'会议消息',text:'利率会议在 90 分钟后。'}];
 const x=extractMaterial(s);assert.deepEqual(x.assets,['ETH']);assert.equal(x.hasTransfer,true);assert.equal(x.claims[0].source,0);assert.match(x.claims[0].text,/240 ETH/);assert.equal(x.sources,2);
 assert.equal(addSource(s,s[0]).error,'duplicate');assert.equal(addSource(Array.from({length:6},(_,i)=>({...s[0],id:i,text:''+i})),{text:'new'}).error,'limit');
 assert.equal(addSource([],{text:'text',href:'javascript:alert(1)'}).sources[0].href,'');
 const numeric=extractMaterial([{text:'2026-10-24 14:00\nETH 24h: -2.13%.\nOI: 13100 million USD'}]);assert.deepEqual(numeric.numbers,['-2.13%','13100 million USD']);assert.ok(!numeric.claims[0].text.startsWith('2026'));
 assert.deepEqual(extractMaterial([{title:'PEPE price',text:'PEPE sample price: 0.00000930 USD'}]).assets,['PEPE']);
});
test('conversation restore is bounded, accepts old corruption safely, and preserves message input as text',()=>{
 assert.deepEqual(normalizeChatStore(null).threads,[]);
 const x=normalizeChatStore({schema:1,active:'a',threads:[{id:'a',title:'<img src=x>',turns:[{id:'b',question:'<script>attack</script>'}],sources:[null,{text:'x',href:'https://outside.test'}]},null]});
 assert.equal(x.active,'a');assert.equal(x.threads[0].turns[0].question,'<script>attack</script>');assert.equal(x.threads[0].sources[0].href,'');
 assert.equal(normalizeChatStore({schema:1,threads:Array.from({length:30},(_,i)=>({id:''+i,turns:[]}))}).threads.length,CHAT_LIMITS.threads);
 assert.equal(questionTopic('这次会消耗多少积分？'),'credits');assert.equal(questionTopic('Explain this wallet transfer'),'chain');
 assert.equal(questionTopic('hi'),'help');assert.equal(questionTopic('hey can u help me?'),'help');assert.equal(questionTopic('你好'),'help');assert.equal(questionTopic('What is the BTC price?'),'market');
 assert.equal(questionLanguage('hey can u help me?'),'en');assert.equal(questionLanguage('What is the BTC price?'),'en');assert.equal(questionLanguage('你好'),'');assert.equal(questionLanguage('BTC 怎么样'),'');
});

test('localized chat history retains its recognized topic and the original question',()=>{
 const value={schema:1,threads:[{id:'ja-chat',turns:[{id:'turn',question:'クレジットはいくら必要ですか？',topic:'credits'},{id:'invalid',question:'custom text',topic:'place-live-order'}]}]};
 const turns=normalizeChatStore(value).threads[0].turns;
 assert.equal(turns[0].question,value.threads[0].turns[0].question);assert.equal(turns[0].topic,'credits');assert.equal(turns[1].topic,null);
});


test('local question routing recognizes the six added interface languages without changing user text',()=>{
 const samples={credits:['クレジットはいくら？','크레딧 비용은?','Cần bao nhiêu điểm?','¿Cuántos créditos cuesta?','Quel coût en crédits ?','Сколько кредитов нужно?'],risk:['ETHのリスクは？','ETH 위험은?','Rủi ro của ETH là gì?','¿Qué riesgos tiene ETH?','Quels risques pour ETH ?','Какие риски у ETH?'],strategy:['戦略を選びたい','전략을 골라줘','Chọn chiến lược nào?','¿Qué estrategia elegir?','Quelle stratégie choisir ?','Какую стратегию выбрать?'],news:['マクロニュースを見たい','거시 뉴스는?','Tin tức vĩ mô mới?','Noticias macroeconómicas','Actualités macroéconomiques','Макроэкономические новости'],chain:['ウォレットを調べたい','지갑 주소를 보고 싶어','Phân tích địa chỉ này','Revisar la billetera','Analyser ce portefeuille','Проверить этот кошелёк'],returns:['利益は保証される？','수익을 보장하나요?','Có đảm bảo lợi nhuận không?','¿Hay beneficios garantizados?','Le rendement est-il garanti ?','Есть гарантия прибыли?']};
 for(const [topic,questions]of Object.entries(samples))for(const question of questions){assert.equal(questionTopic(question),topic,question);}
});


test('macro event risk opens news context while explicit capital protection stays in risk',()=>{
 assert.equal(questionTopic('What should I watch in BTC momentum and macro event risk?'),'news');
 assert.equal(questionTopic('BTC 宏观消息带来了什么风险？'),'news');
 assert.equal(questionTopic('How should I set a stop loss before macro news?'),'risk');
 assert.equal(questionTopic('宏观事件前怎么设置止损和资金保护？'),'risk');
});

test('a greeting does not bill credits or answer with the BTC sample snapshot',async()=>{
 const previous={document:globalThis.document,localStorage:globalThis.localStorage},storage=new Map(),nodes=new Map(),input={value:'hey can u help me?',focus(){}};
 const node=s=>{if(!nodes.has(s))nodes.set(s,{events:{},focus(){},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(s);};
 const root={querySelector:s=>s==='[data-chat-input]'?input:s==='.chat-feed'?{scrollTop:0}:s==='.chat-turn:last-child'||s==='[data-chart="assistant-window"]'?null:node(s),querySelectorAll:()=>[]};
 let billed=0;
 try{
  globalThis.document={addEventListener(){},body:{dataset:{page:'assistant'}},querySelector(){return null;}};
  globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
  const assistant=createTradingAssistant({root,account:{scope:'',s:{scopeType:'personal',tasks:[]},subscribe(){},runTask:async()=>{billed++;return {id:'job'};}},refresh(){},go(){},notify(){},context:()=>({})});
  assistant.bind();node('.chat-composer').onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  input.value='你好';node('.chat-composer').onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  const html=withLocale('zh',()=>assistant.render());
  const titles=[...html.matchAll(/<h3>([^<]*)<\/h3>/g)].map(match=>match[1]);
  assert.equal(billed,0);
  assert.deepEqual(titles,['Ask a specific question','可以直接问']);
  assert.match(html,/交易助手/);
  assert.doesNotMatch(html,/81,230|sample snapshot|样例价格/);
 }finally{for(const [name,value]of Object.entries(previous)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}}
});


test('paste can analyze or stage a source; external quotes remain excerpts and preserve the old chat',()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage,FormData:globalThis.FormData};
 let refreshes=0;
 const storage=new Map(),input={value:'',focus(){}},add={focus(){}},buttons=new Map(),form={values:{title:'ETH update',excerpt:'ETH price rose 2% as trading volume increased.'}};
 const dialog={querySelector:s=>s==='form'?form:add,setAttribute(){},addEventListener(){},showModal(){},close(){}};
 const root={querySelector(s){if(s==='[data-chat-input]')return input;if(s==='[data-chat-add]')return add;if(s==='[data-chart="assistant-window"]'||s==='.chat-turn:last-child'||s==='.chat-feed')return null;if(!buttons.has(s))buttons.set(s,{focus(){},addEventListener(){}});return buttons.get(s);},querySelectorAll:s=>s==='[data-chat-add]'?[add]:[]};
 try{
  globalThis.document={createElement:()=>dialog,body:{append(){}},addEventListener(){}};
  globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  globalThis.FormData=class{constructor(f){return new Map(Object.entries(f.values));}};
  const assistant=createTradingAssistant({root,refresh(){refreshes++;},go(){},notify(){},context:()=>({})});assistant.bind();
  add.onclick();form.onsubmit({preventDefault(){},currentTarget:form,submitter:{value:'analyze'}});
  let store=JSON.parse(storage.get('hive.trading-assistant.v1')),thread=store.threads.find(t=>t.id===store.active);
  assert.equal(thread.turns.length,1);assert.equal(thread.turns[0].sources[0].title,'ETH update');assert.equal(thread.sources.length,0);
  add.onclick();form.onsubmit({preventDefault(){},currentTarget:form,submitter:{value:'attach'}});
  store=JSON.parse(storage.get('hive.trading-assistant.v1'));thread=store.threads.find(t=>t.id===store.active);assert.equal(thread.turns.length,1);assert.equal(thread.sources.length,1);
  assistant.accept({id:'market-SOL',kind:'market',title:'SOL · market snapshot',text:'SOL: 184 USDT'});
  store=JSON.parse(storage.get('hive.trading-assistant.v1'));thread=store.threads.find(t=>t.id===store.active);assert.equal(thread.mode,'ask');assert.equal(thread.turns.length,0);assert.equal(thread.sources.length,1);assert.equal(thread.sources[0].title,'SOL · market snapshot');assert.equal(store.threads.find(t=>t.id!==store.active).turns.length,1);
  for(let i=0;i<24;i++){form.values={title:'News '+i,excerpt:'ETH observed '+i+' price changes.'};add.onclick();form.onsubmit({preventDefault(){},currentTarget:form,submitter:{value:'analyze'}});}
  const beforeLimit=refreshes;form.values={title:'New source',excerpt:'SOL transfer needs confirmation.'};add.onclick();form.onsubmit({preventDefault(){},currentTarget:form,submitter:{value:'analyze'}});
  store=JSON.parse(storage.get('hive.trading-assistant.v1'));thread=store.threads.find(t=>t.id===store.active);assert.equal(thread.turns.length,24);assert.equal(thread.sources.length,1);assert.equal(refreshes,beforeLimit+1);
 }finally{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('Binance task restore preserves only research intent, never connection authority',()=>{
 const value={schema:1,active:'one',threads:[{id:'one',providerTask:'account',providerConnected:true,token:'ignore-this-field',turns:[{id:'a',question:'Read my account',providerTask:'account',providerState:'ready'},{id:'b',question:'Withdraw',providerTask:'withdraw'}]}]};
 const t=normalizeChatStore(value).threads[0];assert.equal(t.providerTask,'account');assert.equal(t.providerConnected,undefined);assert.equal(t.token,undefined);
 assert.equal(t.turns[0].providerTask,'account');assert.equal(t.turns[0].providerState,undefined);assert.equal(t.turns[1].providerTask,null);
});

test('task questions open a separate unsent chat without replacing drafts or carrying unrelated sources',()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage},storage=new Map(),input={value:'My unsaved question',focus(){}},notices=[];
 const key='hive.trading-assistant.v1',old={id:'old',draft:'Saved earlier',mode:'material',providerTask:'account',sources:[{id:'s',title:'Existing source',text:'BTC source'}],turns:[]};
 storage.set(key,JSON.stringify({schema:1,active:'old',threads:[old]}));
 try{
  globalThis.document={addEventListener(){}};globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const root={querySelector:s=>s==='[data-chat-input]'?input:null};
  const assistant=createTradingAssistant({root,refresh(){const s=JSON.parse(storage.get(key));input.value=s.threads.find(t=>t.id===s.active).draft;},go(){},notify:text=>notices.push(text),context:()=>({})});
  assert.equal(assistant.compose('Why did BTC move?'),true);
  let store=JSON.parse(storage.get(key)),thread=store.threads.find(t=>t.id===store.active);
  assert.notEqual(thread.id,'old');assert.equal(thread.draft,'Why did BTC move?');assert.equal(thread.turns.length,0);assert.equal(thread.sources.length,0);assert.equal(thread.providerTask,null);
  assert.equal(store.threads.find(t=>t.id==='old').draft,'My unsaved question');assert.equal(store.threads.find(t=>t.id==='old').sources[0].id,'s');
  for(let i=store.threads.length;i<CHAT_LIMITS.threads;i++)assert.equal(assistant.compose('Question '+i),true);
  const before=storage.get(key);assert.equal(assistant.compose('One more'),false);assert.equal(storage.get(key),before);assert.equal(notices.length,1);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('composer tools and exchange shortcuts preserve the draft, sources and selected task',async t=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage,fetch:globalThis.fetch,innerWidth:globalThis.innerWidth,innerHeight:globalThis.innerHeight};
 globalThis.innerWidth=390;globalThis.innerHeight=844;
 const storage=new Map(),nodes=new Map(),dialogs=[],input={value:'Keep this exact question',focus(){}},source={id:'one',title:'ETH excerpt',text:'ETH transfer; ownership unknown.',href:'',kind:'excerpt'};let externalCalls=0,billingCalls=0;
 const tasks=ASSISTANT_TOOLSETS.flatMap(toolset=>(toolset.exchange?EXCHANGE_OPERATIONS:Object.keys(toolset.tasks)).map(id=>({dataset:{chatToolset:toolset.id,chatTool:id},disabled:!toolset.available})));
 const node=key=>{if(!nodes.has(key))nodes.set(key,{events:{},isConnected:true,dataset:{},style:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k];},matches(){return !!this.popoverOpen;},showPopover(){this.popoverOpen=true;},hidePopover(){this.onbeforetoggle?.({newState:'closed'});this.popoverOpen=false;},getBoundingClientRect(){return {left:16,top:650,bottom:694};},querySelectorAll(s){return s==='[data-chat-capability]'?EXCHANGE_OPERATIONS.map(id=>Object.assign(node('capability-'+id),{dataset:{chatCapability:id}})):[];},value:key==='[data-exchange-asset]'?'BTC':'1H',focus(){this.focused=true;},reset(){},replaceChildren(){this.innerHTML='';},querySelector:node,addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(key);};
 const viewport=Object.assign(new EventTarget(),{width:390,height:844,offsetLeft:0,offsetTop:0});
 const pickerWindow=Object.assign(new EventTarget(),{innerWidth:390,innerHeight:844,visualViewport:viewport});
 const shortcuts=['binance','okx'].map(id=>Object.assign(node('shortcut-'+id),{dataset:{chatExchange:id},ownerDocument:{defaultView:pickerWindow}})),ops=['market','orderbook','candles','funding','analysis','account','positions','fills'].map(id=>({dataset:{exchangeOperation:id},setAttribute(){}}));
 const root={querySelector:s=>s==='[data-chat-input]'?input:s==='.chat-feed'||s==='.chat-turn:last-child'||s==='[data-chart="assistant-window"]'?null:node(s),querySelectorAll:s=>s==='[data-chat-exchange]'?shortcuts:[]};
 storage.set('hive.trading-assistant.v1',JSON.stringify({schema:1,active:'one',threads:[{id:'one',draft:input.value,mode:'ask',providerTask:'account',sources:[source],turns:[]}]}));
 const read=()=>JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0];
 try{
  globalThis.document={createElement:()=>{const dialog={innerHTML:'',open:false,events:{},setAttribute(){},addEventListener(type,fn){this.events[type]=fn;},querySelector:s=>node(s),querySelectorAll:s=>s==='[data-chat-tool]'?tasks:s==='[data-exchange-operation]'?ops:s.includes('data-exchange-asset')?[node('[data-exchange-asset]'),node('[data-exchange-period]')]:[],showModal(){this.open=true;},close(){this.open=false;this.events.close?.();}};dialogs.push(dialog);return dialog;},body:{append(){}},addEventListener(){}};
  globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  globalThis.fetch=()=>{externalCalls++;throw Error('No external call is authorized');};
  const assistant=createTradingAssistant({root,account:{s:{scopeType:"personal",tasks:[]},subscribe(){},async runTask(){billingCalls++;throw Error("Tool data must not enter billing");}},refresh(){},go(){},notify(){},context:()=>({available:600})});assistant.bind();
  const html=assistant.render();assert.match(html,/data-chat-tools aria-label="打开工具"|data-chat-tools aria-label="Open tools"/);assert.doesNotMatch(html,/>Agent OS<\/span>/);
  const composerStart=html.indexOf('<form class="chat-composer">'),composerEnd=html.indexOf('</form>',composerStart),shelfStart=html.indexOf('class="chat-input-tools');assert.ok(shelfStart>composerEnd);const shelf=html.slice(shelfStart);assert.match(shelf,/data-chat-exchange="binance"/);assert.match(shelf,/data-chat-exchange="okx"/);assert.match(shelf,/popover="auto"/);assert.equal((html.match(/data-chat-tools /g)||[]).length,1);assert.doesNotMatch(html.slice(0,html.indexOf('</header>')),/data-chat-tools/);
  node('[data-chat-tools]').events.click();assert.equal(dialogs[0].open,true);
  assert.equal((dialogs[0].innerHTML.match(/ disabled/g)||[]).length,0);
  assert.match(dialogs[0].innerHTML,/data-chat-toolset="binance-agent-os"/);assert.match(dialogs[0].innerHTML,/data-chat-toolset="okx-agent-trade-kit"/);
  assert.equal(ASSISTANT_TOOLSETS.filter(t=>t.exchange).length,2);assert.ok(tasks.every(t=>typeof t.onclick==='function'));
  assert.doesNotMatch(html,/data-chat-return|data-chat-export/);
  assert.equal(read().providerTask,'account');assert.equal(read().turns.length,0);
  const chart=tasks.find(t=>t.dataset.chatTool==='technical');chart.dataset.chatToolset='binance-agent-os';chart.onclick();assert.equal(read().mode,'ask');assert.equal(dialogs[0].open,true);chart.dataset.chatToolset='workspace';chart.onclick();
  let thread=read();assert.equal(thread.mode,'technical');assert.equal(thread.chartOpen,true);assert.equal(thread.providerTask,null);assert.equal(thread.draft,input.value);assert.deepEqual(thread.sources,[source]);assert.equal(thread.turns.length,0);
  assistant.bind();node('[data-chat-tools]').events.click();tasks.find(t=>t.dataset.chatTool==='material').onclick();thread=read();assert.equal(thread.mode,'material');assert.equal(thread.reportOpen,true);assert.equal(thread.draft,input.value);assert.deepEqual(thread.sources,[source]);assert.equal(thread.turns.length,0);
  assistant.bind();node('[data-chat-tools]').events.click();tasks.find(t=>t.dataset.chatTool==='sources').onclick();assert.equal(dialogs[0].open,false);assert.equal(dialogs[1].open,true);assert.match(dialogs[1].innerHTML,/chat-excerpt-form/);assert.equal(read().draft,input.value);assert.equal(read().turns.length,0);assert.equal(externalCalls,0);
  dialogs[1].close();assert.match(assistant.render(),/chat-report-tools/);
  globalThis.fetch=async path=>{externalCalls++;const url=new URL(path,'http://localhost'),provider=url.pathname.split('/')[4];
   if(url.pathname.endsWith('/status'))return Response.json({provider,connected:false});
   assert.ok(url.pathname.endsWith('/market'));return Response.json({provider,operation:'market',asset:'BTC',period:'1H',market:provider==='okx'?'BTC-USDT':'BTCUSDT',unit:'USDT',asOf:1000,private:false,rows:[{last:100,changePct:1,high:110,low:90,volume:2,quoteVolume:200}]});
  };
  for(const shortcut of shortcuts){
   const beforeCalls=externalCalls;shortcut.onclick();const picker=node('#chat-exchange-picker');assert.equal(picker.popoverOpen,true);assert.equal(externalCalls,beforeCalls);
   assert.equal((picker.innerHTML.match(/data-chat-capability=/g)||[]).length,8);assert.ok(node('capability-market').focused);
   node('capability-market').onclick();assert.equal(picker.popoverOpen,false);assert.match(assistant.render(),/data-chat-tool-clear/);assert.match(assistant.render(),/Fetch selected tool data|获取所选工具数据/);
   assistant.bind();await node('.chat-composer').onsubmit({preventDefault(){}});for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));
   assert.match(node('[data-exchange-output]').innerHTML,new RegExp(shortcut.dataset.chatExchange==='okx'?'OKX · BTC-USDT':'Binance · BTCUSDT'));
   dialogs[0].close();assert.ok(node('.chat-send').focused);assert.equal(read().mode,'ask');assert.equal(read().draft,input.value);assert.deepEqual(read().sources,[source]);assert.equal(read().turns.length,0);
   node('[data-chat-tool-clear]').events.click();assert.doesNotMatch(assistant.render(),/class="chat-tool-selection"/);
  }
  await t.test('an open capability picker follows the visible viewport and Escape restores its trigger',()=>{
   const picker=node('#chat-exchange-picker'),shortcut=shortcuts[1];let anchorTop=650;
   shortcut.getBoundingClientRect=()=>({left:210,top:anchorTop,bottom:anchorTop+44});
   shortcut.onclick();
   Object.assign(pickerWindow,{innerWidth:844,innerHeight:390});Object.assign(viewport,{width:844,height:390});anchorTop=280;
   pickerWindow.dispatchEvent(new Event('resize'));
   const bottom=pickerWindow.innerHeight-parseFloat(picker.style.bottom),height=Math.min(285,parseFloat(picker.style.maxHeight));
   assert.ok(bottom-height>=12&&bottom<=anchorTop-8,'the close button and menu stay inside the landscape viewport');
   Object.assign(viewport,{width:240,height:250,offsetLeft:38,offsetTop:72});anchorTop=190;
   viewport.dispatchEvent(new Event('resize'));viewport.dispatchEvent(new Event('scroll'));
   assert.ok(parseFloat(picker.style.left)>=50&&parseFloat(picker.style.left)+parseFloat(picker.style.width)<=266);
   assert.ok(parseFloat(picker.style.top)>=84&&parseFloat(picker.style.top)+parseFloat(picker.style.maxHeight)<=310);
   shortcut.focused=false;
   picker.onkeydown({key:'Escape',preventDefault(){},stopPropagation(){}});
   assert.equal(picker.popoverOpen,false);assert.equal(shortcut.focused,true);
   const closedStyle={...picker.style};anchorTop=400;pickerWindow.dispatchEvent(new Event('resize'));
   assert.deepEqual(picker.style,closedStyle);
  });
  assert.equal(externalCalls,4);assert.equal(billingCalls,0);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('legacy Binance replies can resume local analysis without losing an unsent draft',()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage},storage=new Map(),nodes=new Map(),input={value:'Unsent draft',focus(){}},local={dataset:{chatLocal:'old'}};
 const source={id:'one',title:'ETH excerpt',text:'ETH transfer; ownership unknown.',href:'',kind:'excerpt'};
 storage.set('hive.trading-assistant.v1',JSON.stringify({schema:1,active:'one',threads:[{id:'one',mode:'ask',draft:input.value,turns:[{id:'old',mode:'ask',question:'My Binance question',providerTask:'account',sources:[source]}]}]}));
 const node=key=>{if(!nodes.has(key))nodes.set(key,{events:{},focus(){},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(key);};
 const root={querySelector:s=>s==='[data-chat-input]'?input:s==='.chat-feed'||s==='.chat-turn:last-child'||s==='[data-chart="assistant-window"]'?null:node(s),querySelectorAll:s=>s==='[data-chat-local]'?[local]:[]};
 const notices=[];
 try{
  globalThis.document={addEventListener(){}};globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const assistant=createTradingAssistant({root,refresh(){},go(){},notify:message=>notices.push(message),context:()=>({})});assert.match(assistant.render(),/Not integrated|未接入/);
  assistant.bind();local.onclick();assert.equal(notices.length,1);assert.equal(JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0].draft,'Unsent draft');
  input.value='';assistant.bind();local.onclick();const thread=JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0];assert.equal(thread.draft,'My Binance question');assert.deepEqual(thread.sources,[source]);assert.equal(thread.providerTask,null);assert.equal(thread.turns.length,1);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});


test('Binance capability labels, prompts and recovery actions are translated in all six added locales',async()=>{
 const keys=Object.values(BINANCE_AGENT_OS.tasks).flatMap(task=>[task.label[1],task.detail[1],task.prompt[1]]).concat(['Use existing sources','Connection guide','Open tools','Tools','Close tools','Workspace','Available','Not integrated','Add a source','Research report','Read a chart','Binance tools are not integrated. Wallet sign-in does not grant Binance account access.','View integration docs']);
 for(const locale of ['ja','ko','vi','es','fr','ru']){const {default:pack}=await import(`./locales/${locale}.mjs`);for(const key of keys){assert.equal(typeof pack[key],'string',locale+': '+key);assert.notEqual(pack[key],key,locale+': '+key);}}
});

test('research scope is bounded and strategies stay on their native asset',()=>{
 const c=normalizeResearchConfig({assets:['BTC','BTC','NOPE','ETH','SOL','XRP','BNB','DOGE']});assert.deepEqual(c.assets,['BTC','ETH','SOL','XRP','BNB']);
 const sector=buildResearchReport({scope:'sectors',sectors:['AI']});assert.ok(sector.rows.length);assert.ok(sector.rows.every(r=>r.sector==='AI'));assert.equal(sector.strategies.length,0);
 const eth=buildResearchReport({assets:['ETH']});assert.ok(eth.news.every(n=>n.assets.includes('ETH')));assert.ok(eth.signals.every(s=>s.asset==='ETH'));assert.ok(eth.strategies.length);assert.ok(eth.strategies.every(s=>s.symbol==='ETH'));assert.equal(buildResearchReport({assets:['SOL']}).strategies.length,0);
 assert.equal(researchAssets({scope:'market'}).length,MARKET.length);assert.throws(()=>buildResearchReport({assets:[]}),/research-assets/);
});
test('report dates filter exact candles and records; unavailable history is not filled in',()=>{
 const start=researchDate(RESEARCH_AS_OF-30*3600000),end=researchDate(RESEARCH_AS_OF-10*3600000),report=buildResearchReport({assets:['BTC'],window:'custom',start,end});
 const range=researchRange(report.config),expected=assistantBars(MARKET[0]).filter(b=>b.time-3600000>=range.start&&b.time<=range.end);
 assert.equal(report.rows[0].analysis.start,expected[0].time-3600000);assert.equal(report.rows[0].analysis.end,expected.at(-1).time);assert.equal(report.rows[0].analysis.close,expected.at(-1).close);assert.equal(report.rows[0].volume24h,null);
 assert.ok([...report.news,...report.signals].every(item=>item.at>=range.start&&item.at<=range.end));
 const partial=buildResearchReport({assets:['BTC'],window:'30d'});assert.equal(partial.rows[0].coverage,'partial');assert.equal(partial.rows[0].count,168);
 const future=buildResearchReport({assets:['BTC'],window:'custom',start:'2026-11-01T00:00',end:'2026-11-02T00:00'});assert.equal(future.rows[0].coverage,'none');assert.equal(future.rows[0].analysis,null);assert.equal(future.news.length,0);assert.equal(future.signals.length,0);
 assert.throws(()=>researchRange({window:'custom',start:'2026-10-25T00:00',end:'2026-10-24T00:00'}),/research-time/);assert.throws(()=>researchRange({window:'custom',start:'2026-02-30T00:00'}),/research-time/);
});
test('technical news context matches both the selected instrument and the historical window',()=>{
 const t={asset:'BTC',start:RESEARCH_AS_OF-86400000,end:RESEARCH_AS_OF-3600000},evidence=technicalContext(t);
 assert.ok(evidence.news.every(x=>x.assets.includes('BTC')&&x.at<=t.end&&x.at>=t.start));assert.ok(evidence.signals.every(x=>x.asset==='BTC'&&x.at<=t.end&&x.at>=t.start));
 assert.deepEqual(technicalContext({...t,start:RESEARCH_AS_OF+1,end:RESEARCH_AS_OF+86400000}),{news:[],signals:[]});
});
test('report and evidence snapshots survive reload without granting provider or trading authority',()=>{
 const report=buildResearchReport({assets:['BTC']}),copy=structuredClone(report);report.rows[0].analysis.close+=100;assert.equal(normalizeResearchReport(copy).rows[0].analysis.close,copy.rows[0].analysis.close);
 const value=normalizeChatStore({schema:1,threads:[{id:'research',mode:'material',research:copy.config,reportOpen:false,chartOpen:false,turns:[{id:'one',question:'research',mode:'material',report:copy,apiKey:'private',execute:true}]}]});
 const thread=value.threads[0];assert.equal(thread.reportOpen,false);assert.equal(thread.chartOpen,false);assert.equal(thread.turns[0].report.rows[0].analysis.close,copy.rows[0].analysis.close);assert.equal(thread.turns[0].execute,undefined);assert.equal(thread.turns[0].apiKey,undefined);
 const bad=structuredClone(copy);bad.rows[0].analysis.low=-1;assert.equal(normalizeResearchReport(bad).rows[0].analysis,null);
});
test('share payload contains only the selected public output and rejects malformed or oversized links',async()=>{
 const input={version:1,sample:true,title:'BTC <script>not HTML</script>',text:'中文 research\nEntry: wait for confirmation',mode:'material',apiKey:'private',thread:{turns:['private chat']},sources:[{title:'Markets',href:'?page=markets',text:'private source text'},{title:'Unsafe',href:'javascript:alert(1)'},{title:'Private account',href:'?page=assets&account=private'},{title:'Secret query',href:'?page=markets&api=secret'}]};
 const output=cleanSharedOutput(input);assert.equal(output.apiKey,undefined);assert.equal(output.thread,undefined);assert.equal(output.sources[0].text,undefined);assert.equal(output.sources.length,1);
 const token=await encodeSharedOutput(input);assert.deepEqual(await decodeSharedOutput(token),output);
 const url=new URL(sharedOutputURL('http://localhost:4188/?page=assets&account=private',token,'TEST_123'));assert.equal(url.searchParams.get('ref'),'TEST_123');assert.equal(url.searchParams.get('account'),null);assert.equal(url.hash,'#astarter-share='+token);
 assert.throws(()=>sharedOutputURL('javascript:alert(1)',token,'TEST_123'));assert.throws(()=>sharedOutputURL('https://example.test',token,'bad&ref=someone'));assert.throws(()=>sharedOutputURL('https://example.test','bad#token','TEST_123'));
 await assert.rejects(()=>decodeSharedOutput('v1.invalid'));await assert.rejects(()=>decodeSharedOutput('v1.'+'A'.repeat(12001)));await assert.rejects(()=>encodeSharedOutput({...input,text:'a'.repeat(16001)}));
 const bytes=new Uint8Array(await new Response(new Blob(['a'.repeat(100000)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()),bomb='v1z.'+btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');await assert.rejects(()=>decodeSharedOutput(bomb),/share-size/);
});

test('report generation needs no attachment, and technical follow-ups reuse a frozen window until changed',()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage},storage=new Map(),nodes=new Map(),input={value:'',focus(){}},feed={scrollTop:0},chart={dataset:{rangeStart:'10',visibleCount:'30'}};
 const node=key=>{if(!nodes.has(key))nodes.set(key,{events:{},focus(){},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(key);};
 const root={querySelector:s=>s==='[data-chat-input]'?input:s==='[data-chart="assistant-window"]'?chart:s==='.chat-feed'?feed:s==='.chat-turn:last-child'?null:node(s),querySelectorAll:()=>[]};
 try{
  globalThis.document={addEventListener(){}};globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const initial={schema:1,active:'one',threads:[{id:'one',turns:[],mode:'material',asset:'XAU',research:{assets:['ETH']}}]};storage.set('hive.trading-assistant.v1',JSON.stringify(initial));
  let charged=0;const account={s:{scopeType:'personal',tasks:[]},subscribe(){},runTask(){charged++;}};
  let assistant=createTradingAssistant({account,root,refresh(){},go(){},notify(){},context:()=>({})});assistant.bind();node('[data-report-generate]').events.click();
  let thread=JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0];assert.equal(thread.turns[0].report.rows[0].asset,'ETH');assert.equal(thread.turns[0].sources.length,0);assert.equal(thread.reportOpen,false);assert.equal(thread.turns[0].generatedQuestion,true);assert.doesNotMatch(assistant.render(),/class="chat-user"/);
  assert.match(assistant.render(),/免费历史示例|Free historical example/);assert.match(assistant.render(),/2026-10-24 14:00/);assert.equal(thread.turns[0].billingJob,undefined);
  thread.mode='technical';thread.chartOpen=true;storage.set('hive.trading-assistant.v1',JSON.stringify({schema:1,active:'one',threads:[thread]}));assistant=createTradingAssistant({account,root,refresh(){},go(){},notify(){},context:()=>({})});assistant.bind();node('[data-chat-analyze]').events.click();
  thread=JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0];const first=thread.turns.at(-1).technical;assert.equal(thread.chartOpen,false);
  chart.dataset.rangeStart='50';input.value='这段行情有什么风险？';assistant.bind();input.oninput();node('.chat-composer').onsubmit({preventDefault(){}});
  thread=JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0];assert.equal(thread.turns.at(-1).followup,true);assert.equal(thread.turns.at(-1).technical.start,first.start);assert.equal(thread.turns.at(-1).technical.end,first.end);
  assistant.bind();node('[data-chat-change-window]').events.click();input.value='';assistant.bind();node('[data-chat-analyze]').events.click();thread=JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0];assert.equal(thread.turns.at(-1).followup,false);assert.notEqual(thread.turns.at(-1).technical.start,first.start);assert.equal(charged,0);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('the local share viewer does not open chat storage; returning restores the existing chats',()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage,location:globalThis.location};let reads=0,written=null;
 try{
  globalThis.document={addEventListener(){}};globalThis.location={hash:'#astarter-share=v1.a'};
  globalThis.localStorage={getItem(){reads++;return JSON.stringify({schema:1,active:'saved',threads:[{id:'saved',title:'Saved private chat',turns:[]}]});},setItem(key,value){written=JSON.parse(value);}};
  const assistant=createTradingAssistant({root:{querySelector:()=>null},refresh(){},go(){},notify(){},context:()=>({})});
  assert.equal(reads,0);assert.doesNotMatch(assistant.render(),/Saved private chat/);assert.equal(reads,0);
  globalThis.location.hash='';assert.equal(assistant.compose('A new task question'),true);assert.equal(reads,1);assert.equal(written.threads.length,2);assert.ok(written.threads.some(t=>t.id==='saved'));assert.match(assistant.render(),/A new task question/);assert.match(assistant.render(),/Saved private chat/);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('X drafts leave room for the URL and demo label, including CJK and emoji text',()=>{
 const output={title:'行情😀'.repeat(80),text:'研究结论😀'.repeat(300)},url='https://example.test/s/one?ref=TEST_123',draft=socialDraft(output,url,'x');
 const body=draft.slice(0,-url.length),weight=[...body].reduce((n,c)=>n+(c.codePointAt(0)<128?1:2),0)+23;assert.ok(weight<=280);assert.match(draft,/ASTARTER · DEMO/);assert.ok(draft.endsWith(url));assert.ok(socialDraft(output,url,'telegram').includes(output.text));assert.ok(socialDraft(output,url,'discord').includes(output.text));
});

test('technical questions distinguish RSI, price levels, trend and unavailable indicators',()=>{
 for(const q of ['这段行情 RSI 是多少，是否过热？','What does RSI momentum show?'])assert.equal(technicalIntent(q),'rsi');
 assert.equal(technicalIntent('关键价位在哪里？'),'levels');assert.equal(technicalIntent('What are the support and resistance levels?'),'levels');
 assert.equal(technicalIntent('趋势和 MA20 怎么样？'),'trend');assert.equal(technicalIntent('How does MA200 compare?'),'unsupported');
 assert.equal(technicalIntent('看一下 MACD'),'unsupported');assert.equal(technicalIntent('同期有什么消息？'),'news');assert.equal(technicalIntent('新闻前怎么设止损？'),'risk');
});

test('report reading selects one frozen record and generation leaves the chat draft intact',()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage},nodes=new Map(),feed={scrollTop:0},record={value:'second',events:{},focus(){},addEventListener(type,fn){this.events[type]=fn;}},storage=new Map();
 const first=buildResearchReport({assets:['ETH']}),second=buildResearchReport({assets:['BTC']}),firstSnapshot=JSON.stringify(normalizeResearchReport(first)),draft='Keep my unsent Q&A question';
 storage.set('hive.trading-assistant.v1',JSON.stringify({schema:1,active:'one',threads:[{id:'one',mode:'material',draft,reportId:'first',research:second.config,turns:[{id:'first',mode:'material',question:'ETH report',generatedQuestion:true,report:first},{id:'second',mode:'material',question:'BTC report',generatedQuestion:true,report:second}]}]}));
 const node=key=>{if(!nodes.has(key))nodes.set(key,{events:{},focus(){},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(key);};
 const root={querySelector:s=>s==='[data-chat-input]'||s==='.chat-turn:last-child'||s==='[data-chart="assistant-window"]'?null:s==='.chat-feed'?feed:s==='[data-report-record]'?record:node(s),querySelectorAll:()=>[]};
 try{
  globalThis.document={addEventListener(){}};globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const assistant=createTradingAssistant({root,refresh(){},go(){},notify(){},context:()=>({})});let html=assistant.render();
  assert.equal((html.match(/class="chat-report-result"/g)||[]).length,1);assert.equal((html.match(/data-report-generate/g)||[]).length,1);assert.doesNotMatch(html,/data-chat-input/);
  assert.match(html,/class="chat-report-overview"/);assert.equal((html.match(/data-label=/g)||[]).length,3);assert.match(html,/<table class="chat-report-table" role="table">/);
  assistant.bind();record.events.change({target:record});let thread=JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0];assert.equal(thread.reportId,'second');assert.equal(thread.draft,draft);assert.equal(JSON.stringify(thread.turns[0].report),firstSnapshot);
  record.value='first';assistant.bind();record.events.change({target:record});assistant.bind();node('[data-report-reuse]').events.click();thread=JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0];assert.deepEqual(thread.research.assets,['ETH']);assert.equal(thread.reportOpen,true);
  assistant.bind();node('[data-report-generate]').events.click();thread=JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0];assert.equal(thread.turns.length,3);assert.equal(thread.reportId,thread.turns.at(-1).id);assert.equal(thread.turns.at(-1).report.rows[0].asset,'ETH');assert.equal(thread.draft,draft);assert.equal(JSON.stringify(thread.turns[0].report),firstSnapshot);
  assert.match(assistant.render(),/chat-turn is-new/);assistant.bind();assert.doesNotMatch(assistant.render(),/chat-turn is-new/);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('RSI answers override the old generic topic and shortcut questions preserve drafts and candle windows',()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage},nodes=new Map(),storage=new Map(),input={value:'My unsent question',focus(){}},feed={scrollTop:0},shortcut={dataset:{chatFollowup:'rsi'}};
 const technical={...analyzeBars(assistantBars(MARKET[0]).slice(-40)),asset:'BTC',period:'1H',rsi:73.2};
 storage.set('hive.trading-assistant.v1',JSON.stringify({schema:1,active:'one',threads:[{id:'one',mode:'technical',chartOpen:false,asset:'BTC',period:'1H',turns:[{id:'old',mode:'technical',question:'RSI 是否过热？',topic:'strategy',followup:true,technical}]}]}));
 const node=key=>{if(!nodes.has(key))nodes.set(key,{events:{},focus(){},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(key);};
 const root={querySelector:s=>s==='[data-chat-input]'?input:s==='.chat-feed'?feed:s==='.chat-turn:last-child'||s==='[data-chart="assistant-window"]'?null:node(s),querySelectorAll:s=>s==='[data-chat-followup]'?[shortcut]:[]};
 try{
  globalThis.document={addEventListener(){}};globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const assistant=createTradingAssistant({root,refresh(){},go(){},notify(){},context:()=>({})});const html=assistant.render();assert.match(html,/RSI\(14\) <b>73\.2/);assert.ok(html.includes(researchDate(technical.start).replace('T',' ')));assert.doesNotMatch(html,/ UTC<\/span>/);assert.match(html,/RSI 高于 70|RSI is above 70/);assert.equal((html.match(/data-chat-followup=/g)||[]).length,5);
  assistant.bind();shortcut.onclick();assert.equal(JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0].turns.length,1);
  input.value='';assistant.bind();shortcut.onclick();const thread=JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0];assert.equal(thread.turns.length,2);assert.equal(technicalIntent(thread.turns[1].question),'rsi');assert.equal(thread.turns[1].technical.start,technical.start);assert.equal(thread.turns[1].technical.end,technical.end);assert.equal(thread.turns[1].technical.rsi,73.2);
  thread.turns=[{...thread.turns[0],followup:false,generatedQuestion:false}];storage.set('hive.trading-assistant.v1',JSON.stringify({schema:1,active:'one',threads:[thread]}));const initial=createTradingAssistant({root,refresh(){},go(){},notify(){},context:()=>({})}).render();assert.match(initial,/RSI\(14\) <b>73\.2/);assert.match(initial,/选定行情区间|Selected candle window/);
  thread.turns=[{id:'short',mode:'technical',question:'MA20趋势怎么样？',followup:true,technical:{...analyzeBars(assistantBars(MARKET[0]).slice(-8)),asset:'BTC',period:'1H'}}];storage.set('hive.trading-assistant.v1',JSON.stringify({schema:1,active:'one',threads:[thread]}));const short=createTradingAssistant({root,refresh(){},go(){},notify(){},context:()=>({})}).render();assert.match(short,/MA8/);assert.match(short,/不足以计算完整 MA20|full MA20 cannot be calculated/);
  thread.chartOpen=true;storage.set('hive.trading-assistant.v1',JSON.stringify({schema:1,active:'one',threads:[thread]}));const frozen=JSON.stringify(normalizeChatStore({schema:1,active:'one',threads:[thread]}).threads[0].turns);input.value='Keep this draft';const editor=createTradingAssistant({root,refresh(){},go(){},notify(){},context:()=>({})});assert.match(editor.render(),/data-chat-chart-close/);editor.bind();node('[data-chat-chart-close]').events.click();const returned=JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0];assert.equal(returned.chartOpen,false);assert.equal(returned.draft,'Keep this draft');assert.equal(JSON.stringify(returned.turns),frozen);assert.doesNotMatch(editor.render(),/class="chat-chart-workbench"/);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
test('conversation export keeps inputs but withholds undelivered paid results',async()=>{const {visibleTurn}=await import('./commerce-catalog.mjs');const turn={billingJob:'job',question:'Question',report:{rows:[1]},technical:{close:10},marketContext:{news:[1]}};for(const status of ['reserved','unknown','cancelled','failed',undefined]){const output=visibleTurn(turn,status);assert.equal(output.question,'Question');assert.equal(output.report,null);assert.equal(output.technical,null);assert.equal(output.marketContext,null);}assert.deepEqual(visibleTurn(turn,'complete'),turn);assert.deepEqual(visibleTurn({question:'Free help',report:{rows:[1]}},undefined),{question:'Free help',report:{rows:[1]}});});

test('external sources preserve unsent drafts, analysis mode and attachments without billing',()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage},storage=new Map(),key='hive.trading-assistant.v1',input={value:'Unsent draft'},notices=[];
 const initial={schema:1,active:'old',threads:[{id:'old',draft:'Earlier draft',mode:'technical',providerTask:'account',asset:'ETH',sources:[{id:'old-source',title:'Old source',text:'Original excerpt'}],turns:[]}]};storage.set(key,JSON.stringify(initial));
 try{
  globalThis.document={addEventListener(){}};globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const assistant=createTradingAssistant({root:{querySelector:s=>s==='[data-chat-input]'?input:null},refresh(){},go(){throw Error('No automatic navigation');},notify:text=>notices.push(text),context:()=>({}),account:{subscribe(){},quote(){throw Error('No billing');}}});
  assert.equal(assistant.accept({id:'public',title:'Public ETH source',text:'ETH quote',kind:'market',href:'?page=markets&asset=ETH'}),true);
  let store=JSON.parse(storage.get(key)),old=store.threads.find(t=>t.id==='old'),fresh=store.threads.find(t=>t.id===store.active);
  assert.match(assistant.render(),/data-chat-thread="old"/);assert.ok(assistant.render().includes('Unsent draft'));assert.equal(old.draft,'Unsent draft');assert.equal(old.mode,'technical');assert.equal(old.providerTask,'account');assert.equal(old.sources[0].text,'Original excerpt');
  assert.equal(fresh.mode,'ask');assert.equal(fresh.turns.length,0);assert.equal(fresh.providerTask,null);assert.equal(fresh.sources.length,1);
  while(store.threads.length<CHAT_LIMITS.threads)store.threads.push({...old,id:'full-'+store.threads.length});storage.set(key,JSON.stringify(store));
  const full=createTradingAssistant({root:{querySelector:()=>null},refresh(){},go(){},notify:text=>notices.push(text),context:()=>({})});
  const before=storage.get(key);assert.equal(full.accept({id:'another',title:'Another source',text:'New context'}),false);assert.equal(storage.get(key),before);assert.equal(notices.length,1);
 }finally{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('signal context requires a selected record while explicit text excerpts remain available',t=>{
 const saved={document:globalThis.document,location:globalThis.location,window:globalThis.window,localStorage:globalThis.localStorage},key='hive.trading-assistant.v1',storage=new Map(),routes=[],notices=[];let button,source=null,selection='';
 t.after(()=>{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const initial={schema:1,active:'original',threads:[{id:'original',title:'Saved draft',mode:'ask',draft:'Keep this question',sources:[],turns:[]}]};storage.set(key,JSON.stringify(initial));
 const header={querySelector:()=>button||null,append(b){button=b;}},root={innerText:'An empty signal list is not a signal record',querySelector:s=>s.includes('.sig-page-header>div')?header:s==='.sig-detail-aside,.sc-my-card,.biz-op-detail,.validation-detail'?{innerText:'Select an item to see its plan'}:s==='h1'?{innerText:'AI signals'}:null,querySelectorAll:()=>[]};
 globalThis.document={addEventListener(){},createElement:()=>({dataset:{},setAttribute(){}})};globalThis.location=new URL('http://localhost/?page=signals');globalThis.window={getSelection:()=>({toString:()=>selection})};globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 const assistant=createTradingAssistant({root,refresh(){},go:page=>routes.push(page),notify:text=>notices.push(text),context:()=>({}),signalSource:()=>source});assistant.decorate('signals');
 const before=storage.get(key);button.onpointerdown();button.onclick();assert.equal(routes.length,0);assert.equal(storage.get(key),before);assert.match(notices[0],/调整筛选|Adjust your filters/);
 source={id:'record-2',title:'ETH signal',text:'{"signalId":"SIG-2"}',href:'?page=signals',kind:'excerpt'};button.onpointerdown();button.onclick();
 let store=JSON.parse(storage.get(key)),active=store.threads.find(thread=>thread.id===store.active);assert.deepEqual(routes,['assistant']);assert.equal(active.sources[0].id,'record-2');assert.equal(active.sources[0].text,'{"signalId":"SIG-2"}');assert.match(assistant.render(),/data-chat-source-link="record-2"/);assert.equal(active.turns.length,0);assert.equal(store.threads.find(thread=>thread.id==='original').draft,'Keep this question');
 source=null;selection='User-selected ETH excerpt';button.onpointerdown();button.onclick();store=JSON.parse(storage.get(key));active=store.threads.find(thread=>thread.id===store.active);assert.equal(active.sources[0].text,selection);assert.deepEqual(routes,['assistant','assistant']);assert.equal(store.threads.find(thread=>thread.id==='original').draft,'Keep this question');
});

test('a signal source link restores its existing view and requests only the captured record',t=>{
 const saved={document:globalThis.document,window:globalThis.window,location:globalThis.location,localStorage:globalThis.localStorage},storage=new Map(),routes=[],nodes=new Map(),opened=[];
 t.after(()=>{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 globalThis.document={addEventListener(){}};globalThis.window={dispatchEvent:event=>opened.push({type:event.type,id:event.detail.id})};globalThis.location=new URL('http://localhost/?page=assistant');globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 let href='?page=signals';const id='source:v4:run:SIG-2',link={dataset:{chatSourceLink:id},getAttribute:()=>href};
 const root={querySelector:s=>{if(!nodes.has(s))nodes.set(s,{value:'Keep my draft',dataset:{},addEventListener(){}});return nodes.get(s);},querySelectorAll:s=>s==='[data-chat-source-link]'?[link]:[]};
 const assistant=createTradingAssistant({root,refresh(){},go:(page,context)=>routes.push({page,context}),notify(){},context:()=>({})});assistant.bind();
 let prevented=0;const event={preventDefault(){prevented++;}};
 link.onclick({...event,ctrlKey:true});assert.equal(routes.length,0);assert.equal(prevented,0);
 href='?page=markets&asset=BTC';link.onclick(event);assert.equal(routes.length,0);assert.equal(prevented,0);
 href='?page=signals';link.onclick(event);assert.deepEqual(routes,[{page:'signals',context:{search:href,restore:true}}]);assert.deepEqual(opened,[{type:'hive:signal-source',id}]);assert.equal(prevented,1);
 const active=JSON.parse(storage.get('hive.trading-assistant.v1'));assert.equal(active.threads.find(thread=>thread.id===active.active).draft,'Keep my draft');
});

test('a saved news snapshot labels current news honestly and preserves the excerpt and draft across navigation',t=>{
 const saved={document:globalThis.document,window:globalThis.window,location:globalThis.location,localStorage:globalThis.localStorage},storage=new Map(),nodes=new Map(),routes=[],opened=[],key='hive.trading-assistant.v1';
 t.after(()=>{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const source={id:'public:news:captured',title:'Captured news',text:'2026-10-24 13:55 UTC+8 — Saved original news excerpt',href:'?page=intelligence&data=live',kind:'news'};
 const article={id:'article-fixture',title:'Specific story',text:'A story fixture',href:'?page=intelligence&story=n4',kind:'news'};
 storage.set(key,JSON.stringify({schema:1,active:'one',threads:[{id:'one',mode:'ask',draft:'Earlier draft',sources:[source,article],turns:[]}]}));
 globalThis.document={addEventListener(){}};globalThis.window={dispatchEvent:event=>opened.push(event.type)};globalThis.location=new URL('http://localhost/?page=assistant');globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 const link={dataset:{chatSourceLink:source.id},getAttribute:()=>source.href};
 const root={querySelector:s=>{if(!nodes.has(s))nodes.set(s,{value:'Keep this unsent question',dataset:{},addEventListener(){}});return nodes.get(s);},querySelectorAll:s=>s==='[data-chat-source-link]'?[link]:[]};
 const assistant=createTradingAssistant({root,refresh(){},go:(page,context)=>routes.push({page,context}),notify(){},context:()=>({})});
 assert.match(assistant.render(),/data-chat-source-link="public:news:captured">(?:当前资讯|Current news)/);assert.match(assistant.render(),/data-chat-source-link="article-fixture">(?:打开来源|Open source)/);assert.ok(assistant.render().includes(source.text));
 assistant.bind();let prevented=0;const event={preventDefault(){prevented++;}};link.onclick({...event,ctrlKey:true});assert.equal(prevented,0);assert.equal(routes.length,0);
 link.onclick(event);assert.equal(prevented,1);assert.deepEqual(routes,[{page:'intelligence',context:{search:source.href,restore:true}}]);assert.deepEqual(opened,[]);
 const thread=JSON.parse(storage.get(key)).threads[0];assert.equal(thread.draft,'Keep this unsent question');assert.equal(thread.sources[0].id,source.id);assert.equal(thread.sources[0].text,source.text);assert.equal(thread.sources[0].href,source.href);
 const returned=createTradingAssistant({root,refresh(){},go(){},notify(){},context:()=>({})}).render();assert.ok(returned.includes(source.text));assert.ok(returned.includes('Keep this unsent question'));
});

test('reopening an analysis uses its stored OHLCV after reload, not regenerated fixture prices',async()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage},storage=new Map(),nodes=new Map(),key='hive.trading-assistant.v1',input={value:'',focus(){}},chart={dataset:{rangeStart:'0',visibleCount:'16'}},button={dataset:{chatWindow:'frozen'}},feed={scrollTop:0};
 const bars=assistantBars(MARKET[0]).slice(-16).map(b=>({...b,open:b.open+1000,high:b.high+1000,low:b.low+1000,close:b.close+1000})),technical={...analyzeBars(bars),asset:'BTC',period:'1H',bars};
 const node=s=>{if(!nodes.has(s))nodes.set(s,{events:{},focus(){},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(s);};
 const root={querySelector:s=>s==='[data-chat-input]'?input:s==='[data-chart="assistant-window"]'?chart:s==='.chat-feed'?feed:s==='.chat-turn:last-child'?null:node(s),querySelectorAll:s=>s==='[data-chat-window]'?[button]:[]};
 storage.set(key,JSON.stringify({schema:1,active:'one',threads:[{id:'one',mode:'technical',chartOpen:false,asset:'BTC',turns:[{id:'frozen',mode:'technical',question:'Read this range',technical}]}]}));
 try{
  globalThis.document={addEventListener(){}};globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  let assistant=createTradingAssistant({root,refresh(){},go(){},notify(){},context:()=>({})});assistant.bind();button.onclick();
  let thread=JSON.parse(storage.get(key)).threads[0];assert.equal(thread.windowTurnId,'frozen');assert.deepEqual(thread.range,{start:0,count:16});
  assistant=createTradingAssistant({root,refresh(){},go(){},notify(){},context:()=>({})});assistant.bind();await node('[data-chat-analyze]').events.click();
  thread=JSON.parse(storage.get(key)).threads[0];const reopened=thread.turns.at(-1).technical;
  assert.deepEqual(reopened.bars,bars);assert.equal(reopened.open,technical.open);assert.equal(reopened.clockKind,'historical');assert.equal(reopened.provider,'Astarter fixture');
  const damaged=structuredClone(thread);damaged.turns[0].technical.bars[0].close=-1;
  assert.deepEqual(normalizeChatStore({schema:1,threads:[damaged]}).threads[0].turns[0].technical.bars,[]);
 }finally{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('switching workspace cannot copy a new scope task into the previous assistant history',async()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage},storage=new Map();let listener;
 try{
  globalThis.document={addEventListener(){},body:{dataset:{page:'plans'}},querySelector(){return null;}};
  globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const account={scope:'team',s:{scopeType:'team',tasks:[]},subscribe(fn){listener=fn;}};
  createTradingAssistant({account,root:{querySelector:()=>null},refresh(){},go(){},notify(){},context:()=>({})});
  await new Promise(resolve=>setImmediate(resolve));
  account.scope='personal';account.s={scopeType:'personal',tasks:[{id:'personal-job',status:'complete',settled:1,input:{source:'assistant',threadId:'private',title:'Personal-only result',turn:{id:'turn',mode:'ask',question:'Private question'}}}]};listener();
  assert.equal(storage.has('hive.trading-assistant.v1:team'),false);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('undelivered analyses expose status recovery and cannot be shared or billed again as a follow-up',async()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage};
 try{
  globalThis.document={body:{dataset:{page:'signals'}},querySelector(){return null;},addEventListener(){}};
  for(const status of ['reserved','unknown','failed','cancelled','complete']){
   const storage=new Map(),nodes=new Map(),input={value:'RSI momentum?',focus(){}},feed={scrollTop:0};let quoted=0;
   const now=Math.floor(Date.now()/3600000)*3600000,values=Array.from({length:40},(_,i)=>({time:now/1000-(40-i)*3600,open:100+i,close:101+i,high:102+i,low:99+i,volume:10}));
   const snap=captureMarketWindow({market:'BTC/USDT',period:'1H'},values,{from:0,to:39},{state:'live',asOf:now},now);
   const technical={...snap,...analyzeBars(snap.bars),asset:'BTC'};
   storage.set('hive.trading-assistant.v1',JSON.stringify({schema:1,active:'one',threads:[{id:'one',mode:'technical',chartOpen:false,asset:'BTC',period:'1H',turns:[{id:'turn',mode:'technical',question:'Read this move',billingJob:'job',technical}]}]}));
   globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
   const node=key=>{if(!nodes.has(key))nodes.set(key,{focus(){},addEventListener(){}});return nodes.get(key);};
   const root={querySelector:s=>s==='[data-chat-input]'?input:s==='.chat-feed'?feed:s==='.chat-turn:last-child'||s==='[data-chart="assistant-window"]'?null:node(s),querySelectorAll:()=>[]};
   const account={scope:'',s:{scopeType:'personal',tasks:[{id:'job',status,settled:88}]},subscribe(){},runTask:async()=>{quoted++;return null;}};
   const assistant=createTradingAssistant({root,account,refresh(){},go(){},notify(){},context:()=>({})});
   const html=assistant.render();assistant.bind();await Promise.resolve();
   if(status==='complete'){
    assert.match(html,/88 Credit/);assert.match(html,/data-chat-share=/);assert.match(html,/data-chat-followup=/);
    await input.onkeydown({key:'Enter',preventDefault(){}});
    const [previous,followup]=JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0].turns;
    assert.equal(previous.billingJob,'job');assert.equal(followup.followup,true);assert.equal(followup.technical.clockKind,'wall');
    assert.deepEqual(followup.technical.bars,technical.bars);assert.equal(followup.billingJob,undefined);assert.equal(quoted,0);
    assert.match(assistant.render(),/本地指标计算|Locally calculated indicators/);
   }
   else{assert.doesNotMatch(html,/data-chat-share=|data-chat-followup=/);if(['reserved','unknown'].includes(status))assert.match(html,/chat-task-status/);input.onkeydown({key:'Enter',preventDefault(){}});await Promise.resolve();assert.equal(quoted,0);assert.equal(JSON.parse(storage.get('hive.trading-assistant.v1')).threads[0].turns.length,1);}
  }
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});


test('assistant asset choices group tracked catalog assets without changing selection, drafts or report scope',()=>{
 const previous={document:globalThis.document,localStorage:globalThis.localStorage},store=new Map(),key='hive.trading-assistant.v1',root={querySelector:()=>null,querySelectorAll:()=>[]};
 let watched=['BTC','coin:bitcoin','coin:other-btc','ca:base:0x'+'1'.repeat(40),'SPX'];
 const create=()=>createTradingAssistant({root,refresh(){},go(){throw Error('Rendering cannot navigate');},notify(){},context:()=>({}),getWatchKeys:()=>watched});
 try{
  globalThis.document={addEventListener(){}};globalThis.localStorage={getItem:name=>store.get(name)||null,setItem:(name,value)=>store.set(name,value)};
  store.set(key,JSON.stringify({schema:1,active:'one',threads:[{id:'one',mode:'technical',chartOpen:true,asset:'ETH',draft:'Keep my unsent question',turns:[]}]}));
  const before=store.get(key),assistant=create();let html=assistant.render(),select=html.match(/<select data-chat-asset[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.match(select,/<optgroup label="(?:我的追踪|My watchlist)">/);assert.match(select,/<option value="ETH" selected>/);
  assert.equal((select.match(/value="BTC"/g)||[]).length,1);assert.match(select.split('</optgroup>')[0],/value="SPX"/);assert.doesNotMatch(select.split('</optgroup>')[0],/value="ETH"/);
  watched=['SPX'];select=assistant.render().match(/<select data-chat-asset[^>]*>([\s\S]*?)<\/select>/)[1];assert.match(select,/<option value="ETH" selected>/);assert.equal(store.get(key),before);
  watched=['BTC','coin:bitcoin','SPX'];store.set(key,JSON.stringify({schema:1,active:'report',threads:[{id:'report',mode:'material',reportOpen:true,research:{scope:'assets',assets:['ETH']},draft:'Keep the report draft',turns:[]}]}));
  const reportBefore=store.get(key),report=create().render(),add=report.match(/<select data-report-add[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.match(add,/<optgroup label="(?:我的追踪|My watchlist)">/);assert.match(add,/value="BTC"/);assert.doesNotMatch(add,/value="ETH"/);assert.match(report,/data-report-remove="ETH"/);assert.equal(store.get(key),reportBefore);
 }finally{for(const [name,value]of Object.entries(previous)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}}
});

// R4 step 2 "Link assistant answers to original data/jobs.": recovered chats keep the client's own ids and only this person's jobs.
const r4Escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function r4Assistant({account,saved}={}){
 const previous={document:globalThis.document,localStorage:globalThis.localStorage},storage=new Map(),key='hive.trading-assistant.v1'+(account?.scope?':'+account.scope:'');
 if(saved)storage.set(key,JSON.stringify(saved));
 try{
  globalThis.document={addEventListener(){},body:{dataset:{page:'plans'}},querySelector(){return null;}};
  globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
  const assistant=createTradingAssistant({account,root:{querySelector:()=>null,querySelectorAll:()=>[]},refresh(){},go(){},notify(){},context:()=>({})});
  await new Promise(resolve=>setImmediate(resolve));
  return {html:assistant.render(),stored:storage.has(key)?JSON.parse(storage.get(key)):null};
 }finally{for(const [name,value]of Object.entries(previous)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}}
}
test('assistant history and answer actions write saved chat ids as attribute text',async()=>{
 const thread='thread"><b data-r4-thread>x</b>',turn="turn'><b data-r4-turn>x</b>",technical={...analyzeBars(assistantBars(MARKET[0]).slice(-40)),asset:'BTC',period:'1H'};
 const {html}=await r4Assistant({saved:{schema:1,active:thread,threads:[{id:thread,title:'Saved chat',mode:'technical',chartOpen:false,asset:'BTC',period:'1H',turns:[{id:turn,mode:'technical',question:'Read this move',technical}]}]}});
 assert.doesNotMatch(html,/<b data-r4-/);
 for(const name of ['data-chat-thread','data-chat-pin'])assert.ok(html.includes(`${name}="${r4Escape(thread)}"`),name);
 for(const name of ['data-chat-share','data-chat-window','data-chat-copy'])assert.ok(html.includes(`${name}="${r4Escape(turn)}"`),name);
});
test('assistant recovery keeps only jobs whose thread and turn ids have the client shape',async()=>{
 const own={thread:'4c7d9e2a-1b3f-4a5c-9d8e-0f1a2b3c4d5e',turn:'8e2f4a6b-0c1d-4e3f-a5b6-7c8d9e0f1a2b'},odd={thread:'thread"><b data-r4-thread>x</b>',turn:"turn'><b data-r4-turn>x</b>"};
 const job=(id,ids,question)=>({id,actor:'person-a',status:'complete',settled:1,input:{source:'assistant',threadId:ids.thread,title:question,turn:{id:ids.turn,mode:'ask',question}}});
 const account={scope:'personal',s:{scopeType:'personal',person:'person-a',tasks:[job('7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',odd,'Odd ids'),job('2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',own,'Own question')]},subscribe(){}};
 const {html,stored}=await r4Assistant({account}),ids=stored.threads.flatMap(thread=>[thread.id,...thread.turns.map(turn=>turn.id)]);
 assert.equal(ids.includes(odd.thread),false);assert.equal(ids.includes(odd.turn),false);
 const thread=stored.threads.find(item=>item.id===own.thread);assert.equal(thread?.turns[0]?.id,own.turn);assert.equal(thread.turns[0].question,'Own question');
 assert.doesNotMatch(html,/<b data-r4-/);assert.ok(html.includes(`data-chat-thread="${own.thread}"`));
});
test('assistant recovery in a shared workspace imports only the jobs the signed-in person started',async t=>{
 const {CommerceStore}=await import('./commerce-store.mjs'),{randomUUID}=await import('node:crypto');
 const store=new CommerceStore(':memory:',{now:()=>Date.UTC(2026,10,6,12),jobDelay:1000});t.after(()=>store.close());
 const cmd=(person,scope,action,payload={})=>store.command(person,scope,randomUUID(),action,payload).result,owner=store.session().person,team=cmd(owner,store.snapshot(owner).scope,'team-create').id;
 cmd(owner,team,'order-pay',{id:cmd(owner,team,'order-create',{kind:'plan',product:'team'}).id});
 const member=store.session().person;cmd(member,store.snapshot(member).scope,'team-join',{token:cmd(owner,team,'team-invite').token});
 const ids={thread:randomUUID(),turn:randomUUID()},quote=cmd(owner,team,'quote',{profile:'Q2',input:{source:'assistant',threadId:ids.thread,title:'Owner question',turn:{id:ids.turn,mode:'ask',question:'Owner question',sources:[{id:'s',title:'Owner notes',text:'Pasted by the owner',kind:'excerpt'}]}}});
 cmd(owner,team,'job-start',{quote:quote.id});
 // The member's view carries the owner's own task list, so this test checks the client whatever the server later returns to other members.
 const view=person=>({scope:team,s:store.snapshot(person,team),subscribe(){}}),seen={scope:team,s:{...store.snapshot(member,team),tasks:store.snapshot(owner,team).tasks},subscribe(){}};
 assert.equal(seen.s.person,member);assert.equal(seen.s.tasks[0].actor,owner);assert.equal(seen.s.tasks[0].input.threadId,ids.thread);
 const asMember=await r4Assistant({account:seen});
 assert.equal((asMember.stored?.threads||[]).some(thread=>thread.id===ids.thread),false);assert.doesNotMatch(asMember.html,/Owner question|Owner notes/);
 const asOwner=await r4Assistant({account:view(owner)});
 assert.equal(asOwner.stored.threads.find(thread=>thread.id===ids.thread)?.turns[0]?.id,ids.turn);
});
test('a recovered assistant turn is stored as the saved-chat cleaner keeps it',async()=>{
 const ids={thread:'5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f',turn:'6e7f8091-a2b3-4c4d-9e5f-6a7b8c9d0e1f'},jobId='9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c';
 const turn={id:ids.turn,mode:'ask',question:'Own question',sources:[{id:'s',title:'Outside page',text:'Excerpt',href:'https://example.invalid/page',kind:'news'}]};
 const account={scope:'personal',s:{scopeType:'personal',person:'person-a',tasks:[{id:jobId,actor:'person-a',status:'complete',settled:1,input:{source:'assistant',threadId:ids.thread,title:'Own question',turn}}]},subscribe(){}};
 const {stored}=await r4Assistant({account}),saved=stored.threads.find(thread=>thread.id===ids.thread)?.turns[0];
 assert.equal(saved?.sources[0]?.href,'');
 assert.deepEqual(saved,normalizeChatStore({schema:1,threads:[{id:ids.thread,turns:[{...turn,billingJob:jobId}]}]}).threads[0].turns[0]);
});
test('the period of a saved research report is written as text',async()=>{
 const end='"><b data-r4e>',report=buildResearchReport(normalizeResearchConfig({scope:'assets',assets:['BTC'],window:'24h'}));report.config={...report.config,end};
 const {html}=await r4Assistant({saved:{schema:1,active:'one',threads:[{id:'one',mode:'material',reportId:'r',turns:[{id:'r',mode:'material',question:'BTC report',generatedQuestion:true,report}]}]}});
 assert.doesNotMatch(html,/<b data-r4e>/);assert.ok(html.includes(r4Escape(end)));
});
test('the custom period of saved research settings is written as text',async()=>{
 const start='<b r4s>',end='<b r4e>';
 const {html}=await r4Assistant({saved:{schema:1,active:'one',threads:[{id:'one',mode:'material',reportOpen:false,research:{scope:'assets',assets:['BTC'],window:'custom',start,end},turns:[]}]}});
 assert.doesNotMatch(html,/<b r4[se]>/);assert.ok(html.includes(`${r4Escape(start)}–${r4Escape(end)}`));
});
test('switching workspace cannot copy a well-formed own task into the previous assistant history',async()=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage},storage=new Map();let listener;
 try{
  globalThis.document={addEventListener(){},body:{dataset:{page:'plans'}},querySelector(){return null;}};
  globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
  const account={scope:'team',s:{scopeType:'team',person:'person-a',tasks:[]},subscribe(fn){listener=fn;}},ids={thread:'3a4b5c6d-7e8f-4a9b-8c0d-1e2f3a4b5c6d',turn:'4b5c6d7e-8f9a-4b0c-9d1e-2f3a4b5c6d7e'};
  createTradingAssistant({account,root:{querySelector:()=>null},refresh(){},go(){},notify(){},context:()=>({})});
  await new Promise(resolve=>setImmediate(resolve));
  account.scope='personal';account.s={scopeType:'personal',person:'person-a',tasks:[{id:'5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f',actor:'person-a',status:'complete',settled:1,input:{source:'assistant',threadId:ids.thread,title:'Personal-only result',turn:{id:ids.turn,mode:'ask',question:'Private question'}}}]};listener();
  assert.equal(storage.has('hive.trading-assistant.v1:team'),false);
  createTradingAssistant({account,root:{querySelector:()=>null},refresh(){},go(){},notify(){},context:()=>({})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(JSON.parse(storage.get('hive.trading-assistant.v1:personal')).threads.find(thread=>thread.id===ids.thread)?.turns[0]?.id,ids.turn);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
test('a news headline attached as an assistant source is shown as text',async()=>{
 const title='<b data-r4-title>Headline</b> & more',text='Body <b data-r4-text>x</b>';
 const {html}=await r4Assistant({saved:{schema:1,active:'one',threads:[{id:'one',mode:'ask',turns:[],sources:[{id:'story',title,text,href:'?page=intelligence&story=n1',kind:'news'}]}]}});
 assert.doesNotMatch(html,/<b data-r4-/);
 assert.ok(html.includes(`<summary data-no-translate>${r4Escape(title)}</summary>`));assert.ok(html.includes(`<p data-no-translate>${r4Escape(text)}</p>`));
});

// Reconstruct an older paid conversation with the fixture ledger's quote, reservation, settlement and cancellation.
// Opening it in today's assistant or analyzing its saved XAU candles must never start another paid task.
async function r4PaidChat(t){
 const {commerceFixture}=await import('./commerce-test-fixture.mjs'),previous={document:globalThis.document,localStorage:globalThis.localStorage};
 t.after(()=>{for(const [name,value]of Object.entries(previous)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}});
 const f=await commerceFixture(t),key='hive.trading-assistant.v1:'+f.account.scope,thread=crypto.randomUUID(),started=[],notices=[],nodes=new Map(),threads=[],links=[],input={value:'',focus(){}},chart={dataset:{rangeStart:'10',visibleCount:'30'}};
 const runTask=f.account.runTask;f.account.runTask=request=>{started.push(request);return runTask(request);};
 let storage=new Map([[key,JSON.stringify({schema:1,active:thread,threads:[{id:thread,mode:'technical',asset:'XAU',period:'4H',chartOpen:true,turns:[]}]})]]),listeners=[];
 globalThis.document={addEventListener(){},body:{dataset:{page:'plans'}},querySelector(){return null;}};
 globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
 const node=s=>{if(!nodes.has(s))nodes.set(s,{events:{},focus(){},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(s);};
 const root={querySelector:s=>s==='[data-chat-input]'?input:s==='[data-chart="assistant-window"]'?chart:s==='.chat-feed'?{scrollTop:0}:s==='.chat-turn:last-child'?null:node(s),querySelectorAll:s=>s==='[data-chat-thread]'?threads:s==='[data-commerce-context]'?links:[]};
 const settle=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};
 const open=()=>{const before=new Set(f.account.listeners),assistant=createTradingAssistant({root,account:f.account,refresh(){},go(){},notify:text=>notices.push(text),context:()=>({available:f.account.available,reserved:f.account.reserved,spent:f.account.spent})});listeners=[...f.account.listeners].filter(fn=>!before.has(fn));return assistant;};
 const ask=async(assistant,question)=>{input.value=question;assistant.bind();input.oninput();node('.chat-composer').onsubmit({preventDefault(){}});await settle();};
 const saved=()=>JSON.parse(storage.get(key)).threads.find(item=>item.id===thread);
 const bars=assistantBars(MARKET.find(asset=>asset.symbol==='XAU'),'4H').slice(10,40);
 const technical={...analyzeBars(bars),asset:'XAU',period:'4H',bars,clockKind:'historical',provider:'Astarter fixed historical example'};
 const history=[];
 async function historicalTask(profile,question){
  const turn={id:crypto.randomUUID(),mode:'technical',question,topic:questionTopic(question),sources:[],
   technical,marketContext:technicalContext(technical),followup:history.length>0};
  const request={profile,input:{title:question,source:'assistant',threadId:thread,turn,assets:['XAU'],bars:bars.length}};
  const quote=await f.account.command('quote',request);
  const job=await f.account.command('job-start',{quote:quote.id});
  history.push({...turn,billingJob:job.id});
  storage.set(key,JSON.stringify({schema:1,active:thread,threads:[{id:thread,mode:'technical',asset:'XAU',
   period:'4H',chartOpen:false,turns:history}]}));
  return job.id;
 }
 function closeBrowser(){for(const fn of listeners)f.account.listeners.delete(fn);storage=new Map();}
 await historicalTask('M1','Read this XAU window');
 const pendingBrowser=open();await settle();const pending=pendingBrowser.render();closeBrowser();
 await f.advance(1001);
 await historicalTask('Q1','What are the main risks in this window?');
 await f.advance(1001);
 const cancelled=await historicalTask('Q1','Which price levels matter?');
 await f.account.cancel(cancelled);
 const assistant=open();await settle();
 return {f,thread,started,notices,input,chart,threads,links,pending,assistant,saved,ask,settle,open,
  jobs:history.map(turn=>turn.billingJob),closeBrowser};
}
test('a historical paid chart conversation retains each reservation and settlement, including its cancelled follow-up at zero',async t=>{
 const {estimate}=await import('./commerce-catalog.mjs'),c=await r4PaidChat(t),{f}=c,price=profile=>estimate(profile,f.account.s.plan);
 const jobs=c.jobs.map(id=>f.account.s.tasks.find(job=>job.id===id)),turns=c.saved().turns;
 assert.deepEqual(c.notices,[]);assert.equal(new Set(c.jobs).size,3);
 assert.equal(c.started.length,0);
 assert.deepEqual(jobs.map(job=>[job.profile,job.input.threadId,job.input.turn.id]),turns.map((turn,i)=>[i?'Q1':'M1',c.thread,turn.id]));
 assert.deepEqual(jobs.map(job=>job.input.assets),[['XAU'],['XAU'],['XAU']]);
 assert.deepEqual(jobs.map(job=>[job.status,job.reserved,job.settled]),[['complete',price('M1').max,price('M1').normal],['complete',price('Q1').max,price('Q1').normal],['cancelled',price('Q1').max,0]]);
 assert.equal(f.account.spent,price('M1').normal+price('Q1').normal);assert.equal(f.account.reserved,0);
 assert.deepEqual(turns.map(turn=>turn.followup),[false,true,true]);assert.ok(turns.every(turn=>turn.technical.start===turns[0].technical.start&&turn.technical.end===turns[0].technical.end));
 const html=c.assistant.render();for(const job of jobs.slice(0,2))assert.match(html,new RegExp(`(?:实扣|settled) ${job.settled} Credit`));assert.match(html,/本次任务未交付结果|No result was delivered/);
});
test('each paid assistant answer links to its own task record while pending, settled or cancelled, and following the link keeps the unsent draft',async t=>{
 const c=await r4PaidChat(t),link=id=>`data-commerce-context href="?page=usage&amp;task=${id}"`,html=c.assistant.render();
 assert.match(c.pending,/chat-task-status/);assert.ok(c.pending.includes(link(c.jobs[0])),'pending answer');
 for(const id of c.jobs)assert.equal(html.split(link(id)).length-1,1,id);
 assert.doesNotMatch(html,/data-chat-go="usage"/);
 c.input.value='Keep this unsent question';c.chart.dataset.rangeStart='12';c.links.push({});c.assistant.bind();c.links[0].onclick();
 const thread=c.saved();assert.equal(thread.draft,'Keep this unsent question');assert.deepEqual(thread.range,{start:12,count:30});
});
test('a historical paid chart conversation recovered in another browser reopens its original task links and continues with free local analysis',async t=>{
 const c=await r4PaidChat(t),{f}=c,charged={spent:f.account.spent,tasks:f.account.s.tasks.length,started:c.started.length};
 c.closeBrowser();const assistant=c.open();await c.settle();
 const thread=c.saved();
 assert.deepEqual(thread.turns.map(turn=>turn.billingJob),c.jobs);
 assert.deepEqual([thread.mode,thread.chartOpen,thread.asset,thread.period],['technical',false,'XAU','4H']);
 assert.deepEqual({spent:f.account.spent,tasks:f.account.s.tasks.length,started:c.started.length},charged);
 c.threads.push({dataset:{chatThread:c.thread}});assistant.bind();c.threads[0].onclick();
 const html=assistant.render();
 for(const id of c.jobs)assert.ok(html.includes(`data-commerce-context href="?page=usage&amp;task=${id}"`),id);
 for(const turn of thread.turns.slice(0,2))assert.ok(html.includes(`data-chat-share="${turn.id}"`),turn.id);
 assert.match(html,/data-chat-followup=/);
 await c.ask(assistant,'What do RSI and momentum show in this window?');
 assert.deepEqual({spent:f.account.spent,tasks:f.account.s.tasks.length,started:c.started.length},charged);
 assert.equal(f.account.reserved,0);
 const savedTurns=c.saved().turns,next=savedTurns.at(-1);
 assert.equal(savedTurns.length,thread.turns.length+1);assert.deepEqual(savedTurns.slice(0,-1).map(turn=>turn.billingJob),c.jobs);
 assert.equal(next.followup,true);assert.equal(next.technical.asset,'XAU');assert.equal(next.technical.start,thread.turns[0].technical.start);
 assert.deepEqual(next.technical.bars,thread.turns[0].technical.bars);assert.equal(next.billingJob,undefined);
});
test('a paid conversation stops at 24 turns before any new quote, hold or charge',async()=>{
 const previous={document:globalThis.document,localStorage:globalThis.localStorage},storage=new Map(),nodes=new Map(),notices=[],input={value:'',focus(){}},key='hive.trading-assistant.v1:personal';let quoted=0;
 const tasks=Array.from({length:CHAT_LIMITS.turns},(_,i)=>({id:'job-'+i,status:'complete',settled:2})),turns=tasks.map((job,i)=>({id:'turn-'+i,mode:'ask',question:'BTC question '+i,billingJob:job.id}));
 storage.set(key,JSON.stringify({schema:1,active:'one',threads:[{id:'one',mode:'ask',turns}]}));
 const node=s=>{if(!nodes.has(s))nodes.set(s,{events:{},focus(){},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(s);};
 const root={querySelector:s=>s==='[data-chat-input]'?input:s==='.chat-feed'?{scrollTop:0}:s==='.chat-turn:last-child'||s==='[data-chart="assistant-window"]'?null:node(s),querySelectorAll:()=>[]};
 try{
  globalThis.document={addEventListener(){},body:{dataset:{page:'plans'}},querySelector(){return null;}};globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
  const assistant=createTradingAssistant({root,account:{scope:'personal',s:{scopeType:'personal',person:'person-a',tasks},subscribe(){},runTask:async()=>{quoted++;return null;}},refresh(){},go(){},notify:text=>notices.push(text),context:()=>({})});
  await new Promise(resolve=>setImmediate(resolve));
  input.value='What moved BTC after this?';assistant.bind();input.oninput();node('.chat-composer').onsubmit({preventDefault(){}});
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  const thread=JSON.parse(storage.get(key)).threads[0];
  assert.equal(quoted,0);assert.deepEqual(thread.turns.map(turn=>turn.billingJob),tasks.map(job=>job.id));assert.equal(thread.draft,'What moved BTC after this?');assert.equal(notices.length,1);assert.match(notices[0],/24/);
 }finally{for(const [name,value]of Object.entries(previous)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}}
});
test('a paid answer whose task id cannot form a task link keeps the plain usage button',async()=>{
 const job='f'.repeat(64),account={scope:'personal',s:{scopeType:'personal',person:'person-a',tasks:[{id:job,status:'complete',settled:3}]},subscribe(){}};
 const {html}=await r4Assistant({account,saved:{schema:1,active:'one',threads:[{id:'one',mode:'ask',turns:[{id:'turn',mode:'ask',question:'Why did BTC move?',billingJob:job}]}]}});
 assert.match(html,/(?:实扣|settled) 3 Credit<\/span><button type="button" class="chat-inline-action" data-chat-go="usage">/);assert.doesNotMatch(html,/data-commerce-context/);
});
