import test from 'node:test';
import assert from 'node:assert/strict';
import {MARKET,TRADERS} from './data-center-fixtures.mjs';
import {TRACKING_CASES,trackingRows,signalPreferences,filterSignalPreferences,signalStrategy,signalReferencePlan,publicRunSignals,signalQuote} from './signal-tracking.mjs';
import {SOCIAL_POSTS,socialRows,socialAssetThreads,socialAvatarURL,socialAvatar} from './social-trading.mjs';

test('tracking history uses ordered event prices and reconciles to the market snapshot',()=>{
 const ids=new Set();
 for(const c of TRACKING_CASES){
  const a=MARKET.find(x=>x.symbol===c.id);assert.ok(a);
  assert.equal(c.events[0].change,0);
  assert.ok(Math.abs(c.currentPrice-a.price)<a.price*1e-12);
  assert.equal(c.stage,c.events.at(-1).stage);
  for(const [i,ev] of c.events.entries()){
   assert.ok(!ids.has(ev.id));ids.add(ev.id);
   assert.ok(ev.price>0&&Number.isFinite(ev.price));
   assert.ok(ev.minute<14*60&&(!i||ev.minute>c.events[i-1].minute));
   assert.ok(Math.abs(ev.change-(ev.price/c.firstPrice-1)*100)<1e-9);
  }
 }
 assert.ok(ids.size>40);
});
test('tracking filters intersect source, stage, query and the asset watchlist without mutating history',()=>{
 const before=JSON.stringify(TRACKING_CASES);
 const rows=trackingRows(TRACKING_CASES,{source:'onchain',stage:'confirming',query:'ETH',watched:['ETH'],watchOnly:true});
 assert.equal(rows.length,1);assert.equal(rows[0].symbol,'ETH');assert.equal(rows[0].stage,'confirming');
 assert.ok(trackingRows(TRACKING_CASES,{query:'ETH'}).every(ev=>ev.symbol==='ETH'));
 assert.equal(trackingRows(TRACKING_CASES,{watchOnly:true,watched:[]}).length,0);
 assert.equal(trackingRows(TRACKING_CASES,{query:'not-a-matching-asset'}).length,0);
 assert.equal(JSON.stringify(TRACKING_CASES),before);
});
test('tracking updates sort by event time and retain ended histories',()=>{
 const rows=trackingRows();for(let i=1;i<rows.length;i++)assert.ok(rows[i-1].minute>=rows[i].minute);
 const ended=trackingRows(TRACKING_CASES,{stage:'closed'});assert.ok(ended.length>0);
 for(const ev of ended)assert.ok(ev.track.events.length>1&&ev.track.events.some(x=>x.stage==='discovered'));
});
test('social records keep account identity, valid allocations and original-view links',()=>{
 assert.equal(new Set(SOCIAL_POSTS.map(p=>p.id)).size,SOCIAL_POSTS.length);
 for(const p of SOCIAL_POSTS){
  assert.ok(TRADERS.some(t=>t.id===p.trader));assert.ok(MARKET.some(a=>a.symbol===p.asset));
  assert.match(p.time,/^(0\d|1[0-3]):[0-5]\d$/);
  if(p.side)assert.ok(p.before>=0&&p.before<=100&&p.after>=0&&p.after<=100);
  if(p.related){const original=SOCIAL_POSTS.find(x=>x.id===p.related);assert.ok(original);assert.equal(original.trader,p.trader);assert.equal(original.asset,p.asset);assert.ok(original.time<p.time);}
 }
});

test('scenario accounts retain a stable local avatar and never borrow a real profile photo',()=>{
 const before=JSON.stringify(TRADERS),trader=TRADERS[0];
 const markup=socialAvatar({...trader,avatar_url:'https://pbs.twimg.com/profile_images/123/photo.jpg'});
 assert.match(markup,/data-avatar-kind="geometric"/);assert.doesNotMatch(markup,/background-image|profile_images/);
 assert.equal(markup,socialAvatar(trader));assert.match(markup,/<svg/);
 assert.notEqual(socialAvatar(TRADERS[0]),socialAvatar(TRADERS[1]));
 assert.equal(socialAvatarURL(null),null);assert.match(socialAvatar(null),/<svg/);
 assert.equal(JSON.stringify(TRADERS),before);
});

test('real avatar URLs are credential-free approved images with an intact local fallback',()=>{
 const url='https://pbs.twimg.com/profile_images/123/photo.jpg',real={id:'remote-account-123',avatar_url:url};
 assert.equal(socialAvatarURL(real),url);
 assert.equal(socialAvatarURL({id:'remote-456',avatarUrl:'https://avatars.githubusercontent.com/u/123?v=4'}),'https://avatars.githubusercontent.com/u/123?v=4');
 assert.equal(socialAvatarURL({id:'remote-456',avatar_url:'/assets/avatars/profile.webp'}),'/assets/avatars/profile.webp');
 for(const bad of ['javascript:alert(1)','data:image/svg+xml,test','http://pbs.twimg.com/a.jpg','https://evil.example/a.jpg','https://user:password@pbs.twimg.com/a.jpg','https://pbs.twimg.com/a.jpg?access_token=secret','/assets/../../private/profile.png','//evil.example/a.jpg'])assert.equal(socialAvatarURL({...real,avatar_url:bad}),null,bad);
 const markup=socialAvatar(real);assert.match(markup,/data-avatar-kind="photo"/);assert.match(markup,/<svg/);assert.match(markup,/df-avatar-photo/);assert.doesNotMatch(markup,/onerror|onload/);
});
test('social filters combine followed accounts, asset context, English search and saved records',()=>{
 const rows=socialRows(SOCIAL_POSTS,{kind:'已关注',asset:'ETH',followed:['river']});
 assert.ok(rows.length>0);assert.ok(rows.every(p=>p.trader==='river'&&p.asset==='ETH'));
 assert.ok(socialRows(SOCIAL_POSTS,{query:'ETH'}).every(p=>p.asset==='ETH'));
 const saved=socialRows(SOCIAL_POSTS,{kind:'已收藏',saved:['social-river-idea']});assert.equal(saved.length,1);assert.equal(saved[0].id,'social-river-idea');
 assert.equal(socialRows(SOCIAL_POSTS,{kind:'已关注',followed:[]}).length,0);
 assert.ok(socialRows(SOCIAL_POSTS,{query:'utilization'}).some(p=>p.asset==='AAVE'));
});
test('asset discussion counts come from distinct accounts and actual fixture records',()=>{
 const threads=socialAssetThreads();assert.equal(threads.reduce((n,x)=>n+x.count,0),SOCIAL_POSTS.length);
 for(const x of threads){const rows=SOCIAL_POSTS.filter(p=>p.asset===x.symbol);assert.equal(x.accounts,new Set(rows.map(p=>p.trader)).size);assert.equal(x.positions,rows.filter(p=>p.side).length);}
});


test('current tracking view returns one latest observation per asset and keeps history separate',()=>{
 const before=JSON.stringify(TRACKING_CASES),latest=trackingRows(TRACKING_CASES,{latestOnly:true});
 assert.equal(latest.length,TRACKING_CASES.length);
 assert.equal(new Set(latest.map(x=>x.symbol)).size,latest.length);
 const firstClosed=latest.findIndex(x=>x.stage==='closed');assert.ok(firstClosed>0);assert.ok(latest.slice(firstClosed).every(x=>x.stage==='closed')); 
 for(const row of latest)assert.equal(row.id,row.track.events.at(-1).id);
 const active=trackingRows(TRACKING_CASES,{latestOnly:true,stage:'active'});
 assert.ok(active.length>0&&active.length<latest.length);
 assert.ok(active.every(x=>x.stage!=='closed'));
 const watched=trackingRows(TRACKING_CASES,{latestOnly:true,watchOnly:true,watched:['ETH']});
 assert.equal(watched.length,1);assert.equal(watched[0].symbol,'ETH');
 assert.equal(trackingRows().length,47);
 assert.equal(JSON.stringify(TRACKING_CASES),before);
});

test('Advanced Stats binds immutable history and actual record metrics without inventing goals',async()=>{
 const {signalStatsData,signalCopyText}=await import('./signal-tracking-view.mjs'),row=trackingRows(TRACKING_CASES,{latestOnly:true}).find(row=>row.symbol==='BTC'),before=JSON.stringify(row),data=signalStatsData(row);
 assert.deepEqual(data.history,row.track.events.map(event=>({time:event.time,price:event.price,priceText:event.price.toLocaleString('en-US',{maximumFractionDigits:2})})));
 assert.equal(data.price,row.price);assert.equal(data.kpis[1].value,String(row.track.events.length));assert.equal(data.priceText,row.price.toLocaleString('en-US',{maximumFractionDigits:2}));
 assert.ok(Math.abs(data.change-(row.price/row.track.events[0].price-1)*100)<1e-9);assert.equal(JSON.stringify(row),before);
 assert.equal(Object.hasOwn(data,'goal'),false);assert.equal(Object.hasOwn(data,'confidence'),false);
 const record=publicRunSignals([selectionSignal(2)],{time:100})[0],sparse={record,price:null,track:{id:'ETH',asset:{domain:'Crypto',unit:'USDT'},events:[],record}};
 const missing=signalStatsData(sparse);assert.equal(missing.history.length,0);assert.equal(missing.price,null);assert.equal(missing.condition,'');assert.deepEqual(missing.kpis.slice(0,2).map(kpi=>kpi.value),['RUN-1','SIG-2']);assert.ok(signalCopyText(sparse).includes('v1'));assert.doesNotMatch(signalCopyText(sparse),/^\s*[\[{]/);assert.equal(missing.unit,'USDT');
});

test('recorded quote units are identical in stats, chart values, copy and the readable report',async()=>{
 const {signalStatsData,signalCopyText,signalReportHTML}=await import('./signal-tracking-view.mjs');
 for(const [symbol,unit]of [['BTC','USDT'],['AVAX','USD'],['SPX','点'],['XAU','USD/盎司']]){
  const row=trackingRows(undefined,{asset:symbol,latestOnly:true})[0],before=JSON.stringify(row),data=signalStatsData(row),copy=signalCopyText(row),html=signalReportHTML(row);
  assert.equal(data.unit,unit);assert.equal(data.kpis[0].unit,unit);assert.ok(copy.includes(unit));assert.ok(html.includes(unit));assert.equal(data.history.at(-1).priceText,data.priceText);assert.equal(JSON.stringify(row),before);
  if(symbol==='AVAX'){assert.ok(copy.includes('报价币: USD'));assert.equal(signalQuote(row).settlementAsset,null);assert.ok(!data.unit.includes('USDT'));}
  if(symbol==='SPX'){assert.equal(data.labels.price,'信号记录点位');assert.ok(!copy.includes('USD'));}
 }
 const record=publicRunSignals([{...selectionSignal(2),market:'ETH/USDC',price:2.125}])[0],row={record,price:2.125,track:{id:'ETH',record,asset:{unit:'USD',domain:'Crypto'},events:[]}},data=signalStatsData(row);
 assert.equal(data.unit,'USDC');assert.match(data.unitDescription,/ETH\/USDC/);assert.match(signalCopyText(row),/2\.125 USDC/);assert.doesNotMatch(signalReportHTML(row),/2\.125 USD(?:<|\s)/);
 assert.equal(signalStatsData({...row,record:{...record,instrument:{symbol:'ETH'}}}).unit,'USDC','an explicit original quote survives missing trading metadata');
 const unknown={...row,record:{...record,priceMarket:null,instrument:{symbol:'ETH'}}};assert.equal(signalStatsData(unknown).unit,'单位待确认');assert.match(signalCopyText(unknown),/2\.125 单位待确认/);
 const conflict={...row,record:{...record,priceMarket:'ETH/USDT',instrument:{...record.instrument,symbol:'WETH',market:'WETH/USDC'}}},conflictData=signalStatsData(conflict);
 assert.equal(conflictData.labels.price,'信号记录价格 · ETH/USDT');assert.ok(conflictData.unitDescription.includes(conflictData.labels.price));assert.ok(signalCopyText(conflict).includes(conflictData.labels.price));assert.ok(signalReportHTML(conflict).includes(conflictData.labels.price));
 assert.equal(data.labels.price,'信号记录价格','consistent pairs do not repeat the pair in the main label');assert.equal(signalStatsData(unknown).labels.price,'信号记录价格');
});

test('small recorded prices and signed changes keep their magnitude instead of displaying a false zero',async()=>{
 const {signalStatsData,signalCopyText}=await import('./signal-tracking-view.mjs'),base=trackingRows(undefined,{asset:'AVAX',latestOnly:true})[0];
 for(const move of [1e-7,-1e-7]){
  const events=base.track.events.map((event,i)=>({...event,price:i===base.track.events.length-1?1.23e-10*(1+move):1.23e-10})),track={...base.track,events},row={...events.at(-1),track},data=signalStatsData(row);
  assert.match(data.priceText,/0\.000000000/);assert.notEqual(data.priceText,'0');assert.equal(data.history.at(-1).priceText,data.priceText);assert.equal(data.changeText,move>0?'+<0.01%':'-<0.01%');assert.ok(signalCopyText(row).includes(data.priceText+' USD'));
 }
});

test('action guidance distinguishes observations, orders, fills, expired signals and retrospective rules',async()=>{
 const {signalActionGuidance,signalStatsData}=await import('./signal-tracking-view.mjs'),closed=trackingRows(undefined,{asset:'AVAX',latestOnly:true})[0],risk=trackingRows(undefined,{asset:'SPX',latestOnly:true})[0];
 assert.equal(signalActionGuidance(closed).code,'closed');assert.equal(signalActionGuidance(closed).label,'等待新信号');assert.match(signalActionGuidance(closed).detail,/观察结束不表示已经平仓/);assert.equal(signalActionGuidance(risk).code,'risk');assert.equal(signalStatsData(closed).kpis[2].value,'未关联策略');
 const record=publicRunSignals([selectionSignal(1)],{time:100})[0],row={record,track:{id:'ETH',record,asset:{unit:'USDT'},events:[]}};
 for(const [patch,code]of [[{stage:'submitted'},'order'],[{stage:'confirmed-fill'},'fill'],[{validity:'expired'},'expired'],[{direction:'sell'},'sell']])assert.equal(signalActionGuidance({...row,record:{...record,...patch}}).code,code);
 for(const [status,code]of [['ready','ready'],['not-triggered','unmet'],['error','error'],['loading','loading']]){
  const {signalReferencePlan}=await import('./signal-tracking.mjs'),referencePlan={...signalReferencePlan(row),status},guidance=signalActionGuidance({...row,referencePlan});assert.equal(guidance.code,code);
  if(code==='ready')assert.match(guidance.detail,/原信号时点计算.*重新核验当前条件/);
 }
});

test('clicking a signal card body selects that exact record and preserves independent controls and text selection',async()=>{
 const {createSignalTracker}=await import('./signal-tracking-view.mjs'),previous={document:globalThis.document,matchMedia:globalThis.matchMedia,location:globalThis.location};
 const cards=[],body={closest:()=>null},origin={value:'all',addEventListener(type,handler){this['on'+type]=handler;}};let selectedText='',focused=0;
 const root={querySelector:s=>s==='[data-track-origin]'?origin:null,querySelectorAll:s=>s==='[data-track-record]'?cards:[]};
 const signals=['SIG-1','SIG-2'].map(id=>({id,runId:'RUN-1',sourceId:'research-ETH',version:'v1',market:'ETH/USDT',side:'buy',clockKind:'simulation',observedAt:5}));
 const w={s:{signals,credits:600,aiSignalWatch:[]},touch(){throw Error('Viewing a record must not change business state');}};
 try{
  globalThis.document={body:{append(){}},createElement:()=>({setAttribute(){},addEventListener(){}}),getSelection:()=>({toString:()=>selectedText})};globalThis.matchMedia=()=>({matches:false});globalThis.location={search:'?page=signals'};
  const view=createSignalTracker({w,root,refresh(){},readSnapshot:()=>({time:12})}),before=JSON.stringify(w.s);view.bind();origin.value='bot';origin.onchange({target:origin});const html=view.render({nav:''});
  for(const [,id]of [...html.matchAll(/data-track-record="([^"]+)"/g)].slice(0,2))cards.push({dataset:{trackRecord:id},querySelector:()=>({focus(){focused++;}})});
  assert.match(html,/(?:运行记录|Run history) <b>2<\/b><\/span><span>(?:历史观察记录|Historical observations) <b>0<\/b>/);
  assert.ok(cards.every(card=>card.dataset.trackRecord.startsWith('research-ETH:v1:RUN-1:SIG-')));
  assert.equal(view.sourceSnapshot().id,cards[0].dataset.trackRecord);view.bind();
  cards[1].onclick?.({target:body});
  assert.equal(view.sourceSnapshot().id,cards[1].dataset.trackRecord);assert.equal(focused,1);
  const rerendered=view.render({nav:''});assert.match(rerendered,new RegExp('class="sig-event selected" data-track-record="'+cards[1].dataset.trackRecord+'"'));
  cards[0].onclick?.({target:{closest:()=>({tagName:'BUTTON'})}});assert.equal(view.sourceSnapshot().id,cards[1].dataset.trackRecord);
  cards[0].onclick?.({target:body,defaultPrevented:true});assert.equal(view.sourceSnapshot().id,cards[1].dataset.trackRecord);
  selectedText='ETH';cards[0].onclick?.({target:body});assert.equal(view.sourceSnapshot().id,cards[1].dataset.trackRecord);
  assert.equal(JSON.stringify(w.s),before);
 }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

const selectionSignal=n=>({id:'SIG-'+n,runId:'RUN-1',sourceId:'research-ETH',version:'v1',market:'ETH/USDT',side:'buy',clockKind:'simulation',observedAt:n});
async function signalSelectionHarness(t,{count=3,compact=false,order='latest',reflow=false}={}){
 const {createSignalTracker}=await import('./signal-tracking-view.mjs'),previous={document:globalThis.document,location:globalThis.location,matchMedia:globalThis.matchMedia,localStorage:globalThis.localStorage};
 t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 let html='',view,mode='personal',focused='',watchRemoved=0;const notices=[],returns=[],contexts=[],dialogEvents={};const copy={dataset:{}},exportButton={dataset:{}},feedback={},watch={dataset:{trackWatch:'ETH'},remove(){watchRemoved++;}};
 const open={dataset:{}},next={dataset:{trackPage:'2'}},previousPage={dataset:{trackPage:'1'}},reset={},close={},strategy={dataset:{trackStrategy:'RX03-S'}},link={getAttribute:()=>'?page=markets&asset=ETH'};
 const select=()=>({value:'all',addEventListener(type,handler){this['on'+type]=handler;}}),origin=select(),validity=select(),sort={value:'plans'};
 const dialog={open:false,innerHTML:'',setAttribute(){},addEventListener(type,fn){dialogEvents[type]=fn;},showModal(){this.open=true;},close(){this.open=false;},querySelector:s=>s==='[data-track-close]'?close:s==='[data-track-feedback]'?feedback:null,querySelectorAll:s=>{if(s==='[data-track-link]')return [link];if(s==='[data-track-strategy]')return dialog.innerHTML.includes('data-track-strategy')?[strategy]:[];if(s==='[data-track-watch]')return [watch];if(s==='[data-track-copy]'||s==='[data-track-export]'){const button=s.includes('copy')?copy:exportButton,key=s.includes('copy')?'trackCopy':'trackExport';button.dataset[key]=dialog.innerHTML.match(new RegExp('data-track-'+(key==='trackCopy'?'copy':'export')+'="([^"]+)"'))?.[1];return button.dataset[key]?[button]:[];}return [];}};
 const body={dataset:{page:'signals'},isConnected:true,append(){},focus(){focused='body';}};
 globalThis.document={body,activeElement:body,createElement:()=>dialog,addEventListener(){},getSelection:()=>({toString:()=>''})};globalThis.location={search:'?page=signals'};globalThis.matchMedia=()=>({matches:compact});globalThis.localStorage={getItem:()=>null};
 const focusNode=s=>{const id=s.match(/data-track-record="([^"]+)"/)?.[1];return id&&html.includes('data-track-record="'+id+'"')?{focus(options){focused=id;if(!options?.preventScroll)root.scrollTop=0;}}:null;};
 const root={querySelector:s=>s==='[data-track-origin]'?origin:s==='[data-track-validity]'?validity:s==='[data-sig-sort]'?sort:s==='.sig-feed-meta'?{scrollIntoView(){}}:s.startsWith('[data-track-record=')?focusNode(s):null,querySelectorAll:s=>s==='[data-track-open]'?[open]:s==='[data-track-page]'?[next,previousPage]:s==='[data-track-reset]'?[reset]:s==='[data-track-strategy]'?[strategy]:[]};
 const w={s:{signals:Array.from({length:count},(_,i)=>selectionSignal(i+1)),aiSignalWatch:[],credits:600},touch(){throw Error('Selection must not change business state');}};
 const refresh=()=>{html=view.render({nav:'',view:mode});view.bind();if(reflow)root.scrollTop=0;};
 view=createSignalTracker({w,root,refresh,readSnapshot:()=>({time:100}),notify:message=>notices.push(message),onRelatedLink:(href,onReturn)=>{returns.push(onReturn);return true;},onStrategy:(id,onReturn,source)=>{returns.push(onReturn);contexts.push(source);}});refresh();
 if(order==='latest'){origin.value='bot';origin.onchange({target:origin});origin.value='all';origin.onchange({target:origin});}
 const ids=()=>[...html.matchAll(/<article[^>]*data-track-record="([^"]+)"/g)].map(m=>m[1]);
 const source=()=>view.sourceSnapshot();
 return {view,w,root,dialog,next,previousPage,reset,origin,validity,sort,close,link,strategy,notices,returns,contexts,refresh,ids,html:()=>html,focused:()=>focused,source,dialogEvents,copy,exportButton,feedback,watchRemoved:()=>watchRemoved,
  setMode(value){mode=value;refresh();},
  open(id){open.dataset.trackOpen=ids().find(value=>value===id||value.endsWith(':'+id));assert.ok(open.dataset.trackOpen,id);open.onclick();},
  current(id){const s=source();assert.equal(JSON.parse(s.text).signalId,id);assert.equal(html.match(/class="sig-event selected" data-track-record="([^"]+)"/)?.[1],s.id);assert.ok(html.includes('data-track-copy="'+s.id+'"'));assert.ok(html.includes('data-track-export="'+s.id+'"'));}
 };
}

test('shared target scope intersects independent filters, resets paging and retains the original selected detail',async t=>{
 const {MultiResearch}=await import('./multi-research.mjs'),h=await signalSelectionHarness(t,{count:20}),beforeSignals=JSON.stringify(h.w.s.signals);
 h.w.research=new MultiResearch();h.w.s.workbenchFilter='all';h.w.s.workbenchFocusAsset=null;h.refresh();
 assert.match(h.html(),/target-scope-bar/);assert.equal(h.ids().length,15);const allRevision=h.view.revision();
 h.next.onclick();h.open('SIG-1');h.current('SIG-1');assert.match(h.html(),/<span>2 \/ 3<\/span>/);
 h.w.s.workbenchFocusAsset='ETH';h.refresh();assert.equal(JSON.parse(h.source().text).signalId,'SIG-1');assert.match(h.html(),/<span>1 \/ 2<\/span>/);assert.ok(!h.ids().some(id=>id.endsWith(':SIG-1')));assert.match(h.html().split('<aside class="sig-detail-aside">')[1],/SIG-1/);
 h.refresh();assert.match(h.html(),/<span>1 \/ 2<\/span>/,'a later repaint must not jump back to the selected record page');assert.notEqual(h.view.revision(),allRevision);
 h.origin.value='historical';h.origin.onchange({target:h.origin});assert.ok(h.ids().every(id=>id.startsWith('TRACK-ETH')));
 h.w.s.workbenchFocusAsset='BTC';h.refresh();assert.ok(h.ids().every(id=>id.startsWith('TRACK-BTC')));assert.equal(h.origin.value,'historical');assert.match(h.html(),/当前范围内未选中信号|No signal selected in this scope/);
 h.w.s.workbenchFilter='tracked';h.w.s.aiSignalWatch=['coin:bitcoin'];h.w.s.workbenchFocusAsset=null;h.refresh();assert.ok(h.ids().length);assert.ok(h.ids().every(id=>id.startsWith('TRACK-BTC')));
 assert.equal(JSON.stringify(h.w.s.signals),beforeSignals);assert.equal(h.w.s.credits,600);
});

test('only explicit all-markets action clears shared focus; render and source return keep it',async t=>{
 const {MultiResearch}=await import('./multi-research.mjs'),h=await signalSelectionHarness(t,{count:0});h.w.research=new MultiResearch();h.w.s.workbenchFilter='scan';h.w.s.workbenchFocusAsset='BTC';let saves=0;
 h.w.setWorkbenchTargets=selection=>{Object.assign(h.w.s,{workbenchFilter:selection.filter,workbenchFocusAsset:selection.focusAsset});return null;};h.w.touch=()=>{saves++;};
 h.setMode('all');assert.equal(h.w.s.workbenchFocusAsset,'BTC');assert.ok(h.ids().every(id=>id.startsWith('TRACK-BTC')));assert.equal(saves,0);
 h.open('TRACK-BTC-4');const captured=h.source();h.refresh();assert.equal(h.source().id,captured.id);assert.equal(h.w.s.workbenchFocusAsset,'BTC');
 assert.equal(h.view.clearTargetScope(),true);h.refresh();assert.equal(h.w.s.workbenchFilter,'all');assert.equal(h.w.s.workbenchFocusAsset,null);assert.equal(saves,1);assert.equal(h.ids().length,12);assert.equal(h.source().id,captured.id);
});

test('a requested signal outside shared focus retains its ID and never opens a substitute asset',async t=>{
 const {MultiResearch}=await import('./multi-research.mjs'),h=await signalSelectionHarness(t,{count:0});h.w.research=new MultiResearch();h.w.s.workbenchFilter='all';h.w.s.workbenchFocusAsset='BTC';h.refresh();
 assert.equal(h.view.select('ETH'),true);h.setMode('all');assert.equal(h.source(),null);assert.match(h.html(),/当前范围内未选中信号|No signal selected in this scope/);assert.equal(h.w.s.workbenchFocusAsset,'BTC');
 h.w.s.workbenchFocusAsset=null;h.refresh();assert.equal(h.source().id,'TRACK-ETH-4');assert.match(h.html().split('<aside class="sig-detail-aside">')[1],/<h2 id="sig-detail-title">ETH<\/h2>/);
});

test('rebinding the shared target bar produces one repaint per click and keeps watchlist access',async t=>{
 const {MultiResearch}=await import('./multi-research.mjs'),{createSignalTracker}=await import('./signal-tracking-view.mjs'),previous=globalThis.document;let paints=0,managed=0,events=0,focused=0;
 t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 const button={dataset:{targetAsset:'BTC'},focus(){focused++;}},bar={ownerDocument:{activeElement:button,dispatchEvent(){events++;}},contains:()=>true},root={querySelector:()=>null,querySelectorAll:selector=>selector==='.target-scope-bar'?[bar]:selector==='[data-target-asset],[data-target-filter],[data-target-filter-select]'?[button]:[]};
 globalThis.document={body:{append(){}},createElement:()=>({setAttribute(){},addEventListener(){}})};
 const research=new MultiResearch(),w={s:{workbenchFilter:'all',workbenchFocusAsset:null,aiSignalWatch:[]},setWorkbenchTargets(s){this.s.workbenchFilter=s.filter;this.s.workbenchFocusAsset=s.focusAsset;return null;},touch(){}};
 const view=createSignalTracker({w,research,root,onManageWatch:()=>{managed++;},refresh(){paints++;view.render({nav:''});view.bind();}});view.render({nav:''});view.bind();view.bind();
 bar.onclick({target:{closest:()=>button}});assert.equal(paints,1);assert.equal(events,1);assert.equal(w.s.workbenchFocusAsset,'BTC');assert.equal(focused,1);
 bar.onclick({target:{closest:()=>button}});assert.equal(paints,2);assert.equal(w.s.workbenchFocusAsset,null);
 bar.onclick({target:{closest:()=>({dataset:{targetManage:''}})}});assert.equal(managed,1);assert.equal(paints,2);
});

test('signal detail links merge only identical market targets and preserve the original return',async t=>{
 const h=await signalSelectionHarness(t,{count:1,compact:true}),before=JSON.stringify(h.w.s);
 const rows=trackingRows(TRACKING_CASES,{latestOnly:true});
 for(const [id,c]of [['SIG-1',{id:'ETH'}],...rows.map(row=>[row.id,row.track])]){
  h.open(id);const links=h.dialog.innerHTML.match(/class="sig-detail-links">([\s\S]*?)<\/div>/)[1];
  const hrefs=[...links.matchAll(/href="([^"]+)"/g)].map(match=>match[1]),market='?page=markets&asset='+c.id;
  const related=c.source==='macro'&&c.href==='?page=intelligence'||c.source==='onchain'&&c.href==='?page=tracking'?null:c.href;
  assert.deepEqual(hrefs,related&&related!==market?[market,related]:[market],id);
 }
 h.open('SIG-1');const source=h.source().text;h.link.onclick({preventDefault(){}});assert.equal(h.dialog.open,false);
 h.returns.at(-1)();h.current('SIG-1');assert.equal(h.source().text,source);assert.equal(JSON.stringify(h.w.s),before);
});

test('unbound XAU macro history omits the generic news jump and keeps its unique market link and record',async t=>{
 const h=await signalSelectionHarness(t,{count:0,compact:true}),state=JSON.stringify(h.w.s),history=JSON.stringify(TRACKING_CASES);
 h.open('TRACK-XAU-5');
 for(const html of [h.html().split('<aside class="sig-detail-aside">')[1],h.dialog.innerHTML]){
  const links=html.match(/class="sig-detail-links">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...links.matchAll(/href="([^"]+)"/g)].map(m=>m[1]),['?page=markets&asset=XAU']);
  assert.doesNotMatch(html,/href="\?page=intelligence"/);assert.match(html,/class="sig-review"/);
 }
 const record=JSON.parse(h.source().text);assert.equal(record.signalId,'TRACK-XAU-5');assert.equal(record.price,2720);assert.equal(record.observedAt,'2026-10-24T13:55:00+08:00');
 assert.equal(JSON.stringify(h.w.s),state);assert.equal(JSON.stringify(TRACKING_CASES),history);
});

test('AAVE omits unbound chain navigation while ETH metrics and the SUI empty-state route stay available',async t=>{
 const h=await signalSelectionHarness(t,{count:0,compact:true}),before=JSON.stringify(h.w.s),history=JSON.stringify(TRACKING_CASES),rows=trackingRows(TRACKING_CASES,{latestOnly:true});
 const aave=rows.find(row=>row.symbol==='AAVE');h.open(aave.id);
 for(const html of [h.html().split('<aside class="sig-detail-aside">')[1],h.dialog.innerHTML]){
  const links=html.match(/class="sig-detail-links">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...links.matchAll(/href="([^"]+)"/g)].map(m=>m[1]),['?page=markets&asset=AAVE']);assert.match(html,/class="sig-review"/);
 }
 assert.equal(JSON.parse(h.source().text).price,aave.price);
 for(const [symbol,target]of [['ETH','?page=tracking&metric=stablecoins'],['SUI','?page=social&asset=SUI']]){
  h.open(rows.find(row=>row.symbol===symbol).id);const links=h.dialog.innerHTML.match(/class="sig-detail-links">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...links.matchAll(/href="([^"]+)"/g)].map(m=>m[1]),['?page=markets&asset='+symbol,target]);
 }
 assert.equal(JSON.stringify(h.w.s),before);assert.equal(JSON.stringify(TRACKING_CASES),history);
});

test('historical signals without a plan keep one market destination and return to the same record',async t=>{
 const h=await signalSelectionHarness(t,{count:0,compact:true}),before=JSON.stringify(h.w.s);
 const rows=trackingRows(TRACKING_CASES,{latestOnly:true}).filter(row=>!signalStrategy(row.track));assert.ok(rows.length);
 for(const row of rows){
  h.open(row.id);const market='?page=markets&asset='+row.track.id;
  const hrefs=[...h.dialog.innerHTML.matchAll(/href="([^"]+)"/g)].map(match=>match[1]);assert.equal(hrefs.filter(href=>href===market).length,1,row.id);
  assert.match(h.dialog.innerHTML,/class="sig-review"/);assert.equal(JSON.parse(h.source().text).plan,null);
 }
 const row=rows[0];h.open(row.id);const source=h.source().text;h.root.scrollTop=180;h.link.getAttribute=()=>'?page=markets&asset='+row.track.id;
 h.link.onclick({preventDefault(){}});assert.equal(h.dialog.open,false);h.returns.at(-1)();h.current(row.id);
 assert.equal(h.source().text,source);assert.equal(h.root.scrollTop,180);assert.equal(JSON.stringify(h.w.s),before);
});

test('expired signal cards omit repeated validity while preserving active, unknown and order states',async()=>{
 const {build}=await import('esbuild'),{fileURLToPath}=await import('node:url');
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const {signalStatsData}=await import('./signal-tracking-view.mjs');
 const result=await build({entryPoints:[fileURLToPath(new URL('./signal-stats/advanced-stats.jsx',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',packages:'external',jsx:'automatic',logLevel:'silent'});
 const code=result.outputFiles[0].text.replace(/from (["'])([^"']+)\1/g,(_match,_quote,specifier)=>'from '+JSON.stringify(import.meta.resolve(specifier)));
 const {AdvancedStats}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const [base]=publicRunSignals([selectionSignal(1)],{time:100});
 for(const validity of ['expired','active','unknown'])for(const stage of ['analysis','submitted','confirmed-fill']){
  const record={...base,validity,stage},row={record,price:null,track:{id:'ETH',asset:{symbol:'ETH',domain:'Crypto',unit:'USDT'},events:[],record}},before=JSON.stringify(row),data=signalStatsData(row);
  const html=renderToStaticMarkup(createElement(AdvancedStats,{data,reducedMotion:true}));
  if(validity==='expired')assert.doesNotMatch(html,/sig-stats-validity/);
  if(validity==='active'){assert.match(html,/sig-stats-validity/);assert.ok(html.includes(data.validity));}
  if(validity==='unknown')assert.equal(data.validity,data.labels.unavailable);
  assert.ok(html.includes(data.labels.unavailable));assert.equal(data.price,null);assert.equal(row.record.stage,stage);
  assert.match(data.stage,stage==='confirmed-fill'?/已确认成交|Confirmed fill/:stage==='submitted'?/下单尝试|Order attempt/:/分析判断|Analysis/);
  assert.equal(JSON.stringify(row),before);
 }
 for(const symbol of ['BTC','AVAX','SPX','XAU']){
  const row=trackingRows(undefined,{asset:symbol,latestOnly:true})[0],data=signalStatsData(row),html=renderToStaticMarkup(createElement(AdvancedStats,{data,reducedMotion:true}));
  assert.ok(html.includes(data.unit));assert.ok(html.includes(data.priceText));assert.ok(html.includes(data.history.at(-1).priceText));assert.ok(html.includes(data.labels.price));assert.doesNotMatch(html,/参考策略.*未提供/);
 }
});

test('signal clocks name the simulation once and retain unknown times and real UTC clocks',async t=>{
 const {formatSimulationTime}=await import('./product-help.mjs'),h=await signalSelectionHarness(t,{count:0});
 const plain=html=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
 for(const [clockKind,observedAt,footer,detail]of [
  ['simulation',6420,formatSimulationTime(6420),formatSimulationTime(6420)],
  ['simulation',0,formatSimulationTime(0),formatSimulationTime(0)],
  ['simulation',null,'— SIM','— SIM'],
  ['wall',Date.UTC(2026,9,24,6),'2026-10-24 · 06:00 UTC','2026-10-24 06:00 UTC'],
  ['wall',null,'— UTC','— UTC']
 ]){
  h.w.s.signals=[{...selectionSignal(1),clockKind,observedAt}];const before=JSON.stringify(h.w.s);h.refresh();h.open('SIG-1');
  const id=h.source().id,card=h.html().split('data-track-record="'+id+'"')[1].split('</article>')[0];
  assert.equal(plain(card.match(/class="sig-event-time">([\s\S]*?)<\/div>/)[1]),footer);
  const quote=h.html().match(/class="sig-detail-quote"><small>(.*?)<\/small>/)[1];assert.ok(plain(quote).endsWith(detail),quote);
  const record=JSON.parse(h.source().text);assert.equal(record.observedAt,observedAt);assert.equal(record.price,null);assert.equal(record.stage,'analysis');assert.equal(record.sourceId,'research-ETH');
  if(clockKind==='simulation')assert.doesNotMatch(card.match(/class="sig-event-time">([\s\S]*?)<\/div>/)[1],/datetime=/);
  assert.equal(JSON.stringify(h.w.s),before);
 }
 h.open('TRACK-XAU-5');assert.match(h.html(),/datetime="2026-[^"]*\+08:00"/);assert.match(h.html(),/UTC\+8/);
});

test('signal selection follows its record after new data crosses a page boundary, while explicit paging selects the requested page',async t=>{
 const h=await signalSelectionHarness(t,{count:15});h.open('SIG-1');h.current('SIG-1');
 h.w.s.signals.push(selectionSignal(16));h.refresh();h.current('SIG-1');assert.match(h.html(),/<span>2 \/ 2<\/span>/);
 h.previousPage.onclick();h.current('SIG-16');assert.match(h.html(),/<span>1 \/ 2<\/span>/);
 h.next.onclick();h.current('SIG-1');assert.match(h.html(),/<span>2 \/ 2<\/span>/);
 h.refresh();h.current('SIG-1');
});

test('an explicitly requested signal plan remains selected when live records place it beyond the first page',async t=>{
 const h=await signalSelectionHarness(t,{count:16});assert.equal(h.view.select('ETH'),true);h.refresh();h.current('TRACK-ETH-4');assert.match(h.html(),/<span>2 \/ 2<\/span>/);
});

test('empty signal filters clear the selection instead of reviving a hidden record when filters reset',async t=>{
 const h=await signalSelectionHarness(t),before=JSON.stringify(h.w.s);h.open('SIG-2');h.current('SIG-2');
 h.validity.value='active';h.validity.onchange({target:h.validity});assert.equal(h.source(),null);assert.equal(h.ids().length,0);assert.doesNotMatch(h.html(),/data-track-copy|class="sig-event selected"/);
 h.reset.onclick();h.current('SIG-3');assert.equal(JSON.stringify(h.w.s),before);
});

test('switching signal views starts at the first result when the selected record is excluded',async t=>{
 const h=await signalSelectionHarness(t,{count:16});h.open('SIG-8');
 h.w.s.signals.push(...Array.from({length:16},(_,i)=>({...selectionSignal(i+17),sourceId:'research-BTC',market:'BTC/USDT',observedAt:i+1})));h.refresh();h.current('SIG-8');assert.match(h.html(),/<span>2 \/ 3<\/span>/);
 h.w.s.aiSignalWatch=['BTC'];h.setMode('watch');h.current('SIG-32');assert.match(h.html(),/<span>1 \/ 2<\/span>/);
});

test('assistant source return restores its captured record and never substitutes a removed record',async t=>{
 const oldWindow=globalThis.window,listeners={};t.after(()=>{if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;});
 globalThis.window={addEventListener(type,handler){listeners[type]=handler;}};
 const h=await signalSelectionHarness(t,{compact:true}),before=JSON.stringify(h.w.s);h.open('SIG-2');const id=h.source().id;h.close.onclick();h.open('SIG-3');h.close.onclick();
 listeners['hive:signal-source']({detail:{id}});h.current('SIG-2');assert.equal(h.dialog.open,true);h.close.onclick();assert.equal(h.focused(),id);assert.equal(JSON.stringify(h.w.s),before);
 h.w.s.signals=h.w.s.signals.filter(s=>s.id!=='SIG-2');h.refresh();listeners['hive:signal-source']({detail:{id}});
 assert.equal(h.source(),null);assert.equal(h.dialog.open,false);assert.doesNotMatch(h.html(),/class="sig-event selected"|data-track-copy/);assert.equal(h.notices.length,1);
});

test('closing a narrow-screen signal detail synchronizes the list and returns focus to that record',async t=>{
 const h=await signalSelectionHarness(t,{compact:true}),before=JSON.stringify(h.w.s);h.open('SIG-2');assert.equal(h.dialog.open,true);h.current('SIG-2');
 h.close.onclick();assert.equal(h.dialog.open,false);h.current('SIG-2');assert.equal(h.focused(),h.source().id);assert.equal(JSON.stringify(h.w.s),before);
});

test('opening and closing a filtered narrow-screen detail preserves scroll and focus across a feed reflow',async t=>{
 const h=await signalSelectionHarness(t,{compact:true,reflow:true});h.origin.value='bot';h.origin.onchange({target:h.origin});h.root.scrollTop=476;h.open('SIG-2');assert.equal(h.root.scrollTop,476);
 h.close.onclick();assert.equal(h.root.scrollTop,476);h.current('SIG-2');assert.equal(h.focused(),h.source().id);assert.match(h.html(),/<option value="bot" selected>/);
});

test('returning from related data does not substitute a different signal when the original record was removed',async t=>{
 const h=await signalSelectionHarness(t,{compact:true});h.open('SIG-2');h.link.onclick({preventDefault(){}});assert.equal(h.dialog.open,false);
 h.w.s.signals=h.w.s.signals.filter(s=>s.id!=='SIG-2');h.refresh();assert.equal(h.source(),null);h.returns[0]();
 assert.equal(h.dialog.open,false);assert.equal(h.source(),null);assert.doesNotMatch(h.html(),/class="sig-event selected"|data-track-copy/);assert.match(h.html(),/记录暂不可用|Record unavailable/);assert.equal(h.notices.length,1);assert.match(h.notices[0],/记录暂不可用|Record unavailable/);
 h.open('SIG-3');h.current('SIG-3');
});

test('desktop strategy return restores its captured signal even after another record is selected',async t=>{
 const h=await signalSelectionHarness(t),before=JSON.stringify(h.w.s);h.open('TRACK-ETH-4');h.strategy.onclick();assert.equal(typeof h.returns[0],'function');
 h.open('TRACK-BTC-4');h.returns[0]();h.current('TRACK-ETH-4');assert.equal(h.dialog.open,false);assert.equal(JSON.stringify(h.w.s),before);
});

for(const compact of [false,true])test(`returning from a strategy does not open another asset after the watched signal leaves the result set (${compact?'mobile':'desktop'})`,async t=>{
 const h=await signalSelectionHarness(t,{compact});h.w.s.aiSignalWatch=['ETH','BTC'];h.setMode('watch');h.open('TRACK-ETH-4');h.strategy.onclick();assert.equal(h.dialog.open,false);
 const context=h.contexts[0];assert.ok(context);assert.equal(context.signalId,'TRACK-ETH-4');assert.equal(context.sourceId,'TRACK-ETH');assert.equal(context.version,'4');assert.equal(context.instrument.symbol,'ETH');assert.equal(context.instrument.market,null);assert.equal(context.instrument.venue,null);assert.equal(context.clockKind,'historical');assert.equal(context.observedAt,'2026-10-24T12:10:00+08:00');
 h.w.s.aiSignalWatch=['BTC'];h.refresh();h.returns[0]();assert.equal(h.dialog.open,false);assert.equal(h.source(),null);assert.doesNotMatch(h.html(),/class="sig-event selected"|data-track-copy/);assert.equal(h.notices.length,1);
 h.open('TRACK-BTC-4');h.current('TRACK-BTC-4');
});

test('closing a signal that disappeared during viewing leaves no substituted selection and supports an explicit new choice',async t=>{
 const h=await signalSelectionHarness(t,{compact:true});h.open('SIG-2');h.w.s.signals=h.w.s.signals.filter(s=>s.id!=='SIG-2');h.close.onclick();
 assert.equal(h.dialog.open,false);assert.equal(h.source(),null);assert.match(h.html(),/记录暂不可用|Record unavailable/);assert.doesNotMatch(h.html(),/class="sig-event selected"|data-track-copy/);
 h.refresh();assert.equal(h.source(),null);assert.match(h.html(),/记录暂不可用|Record unavailable/);
 h.open('SIG-1');h.current('SIG-1');
});

test('a signal removed while its detail is open cannot open a strategy without its source',async t=>{
 const h=await signalSelectionHarness(t,{compact:true});h.w.s.aiSignalWatch=['ETH'];h.setMode('watch');h.open('TRACK-ETH-4');h.w.s.aiSignalWatch=[];h.strategy.onclick();
 assert.equal(h.contexts.length,0);assert.equal(h.dialog.open,false);assert.equal(h.source(),null);assert.equal(h.notices.length,1);
});

test('the currently selected signal is exposed as exactly one current article',async t=>{
 const h=await signalSelectionHarness(t);h.open('SIG-1');h.current('SIG-1');assert.ok(h.html().includes('data-track-record="'+h.source().id+'" aria-current="true"'));assert.equal([...h.html().matchAll(/aria-current="true"/g)].length,1);assert.match(h.html(),/class="sig-current-marker" aria-hidden="true">✓<\/span>/);
});

test('signal feed exposes distinct record identities and missing evidence without inventing a price or empty history',async t=>{
 const h=await signalSelectionHarness(t),before=JSON.stringify(h.w.s);h.open('SIG-2');const html=h.html(),aside=html.split('<aside class="sig-detail-aside">')[1];
 const selectedCard=html.match(/<article class="sig-event selected"[\s\S]*?<\/article>/)?.[0];assert.ok(selectedCard);assert.match(selectedCard,/class="sig-record-reference">RUN-1<\/b>/);assert.match(selectedCard,/class="sig-record-reference">SIG-2<\/b>/);
 assert.match(aside,/class="sig-price-missing">未提供|class="sig-price-missing">Not provided/);
 assert.match(aside,/证据|Evidence/);assert.match(aside,/>RUN-1<\/dd>/);assert.match(aside,/>SIG-2<\/dd>/);assert.match(aside,/>v1<\/dd>/);
 assert.doesNotMatch(aside,/class="sig-history"|— <small>USDT/);assert.doesNotMatch(html,/BOT 运行判断/);
 assert.ok(html.indexOf('data-track-origin')<html.indexOf('<details class="sig-filter-panel"'));
 h.origin.value='historical';h.origin.onchange({target:h.origin});assert.ok(h.ids().every(id=>id.startsWith('TRACK-')));assert.equal(JSON.stringify(h.w.s),before);
});

test('historical signal cards show the recorded tracking stage and retain their original history and clock',async t=>{
 const h=await signalSelectionHarness(t,{count:0});
 assert.match(h.html(),/data-stage="risk">风险变化|data-stage="risk">Risk change/);
 h.open('TRACK-XAU-5');h.current('TRACK-XAU-5');const aside=h.html().split('<aside class="sig-detail-aside">')[1];
 assert.match(h.html(),/data-stage="closed">观察结束|data-stage="closed">Observation ended/);
 assert.match(aside,/class="sig-history"/);assert.match(aside,/历史记录 · 观察结束|Historical record · Observation ended/);assert.match(aside,/2026-10-24/);assert.equal(JSON.parse(h.source().text).clockKind,'historical');assert.equal(JSON.parse(h.source().text).observedAt,'2026-10-24T13:55:00+08:00');
});

test('one signal feed retains run records and historical observations without plan categories',async t=>{
 const h=await signalSelectionHarness(t);assert.ok(h.ids()[0].endsWith(':SIG-3'));assert.ok(h.ids().includes('TRACK-ETH-4'));assert.ok(h.ids().includes('TRACK-BTC-4'));assert.ok(h.ids().indexOf('TRACK-XAU-5')<h.ids().indexOf('TRACK-ETH-4'));assert.doesNotMatch(h.html(),/份示例方案|查看线索|查看方案|data-sig-sort/);assert.match(h.html(),/解读信号/);
});

test('historical review uses only observations available at the selected record and travels with the public excerpt',async()=>{
 const {trackingReview,trackingRecord,signalExcerpt}=await import('./signal-tracking.mjs'),btc=TRACKING_CASES.find(c=>c.id==='BTC'),before=JSON.stringify(btc);
 const row={...btc.events[1],track:btc},review=trackingReview(row);
 assert.equal(review.observations,2);assert.equal(review.asOf,'2026-10-24T10:53:00+08:00');assert.ok(Math.abs(review.changePercent-.6)<1e-9);assert.ok(Math.abs(review.latestChangePercent-.6)<1e-9);assert.equal(review.drawdownFromPeakPercent,0);assert.equal(review.path.length,2);assert.equal(review.path.at(-1).price,row.price);
 assert.deepEqual(trackingRecord(row).review,review);assert.deepEqual(JSON.parse(signalExcerpt(row)).review,review);assert.equal(JSON.stringify(btc),before);
 const latest=trackingReview({...btc.events.at(-1),track:btc});assert.ok(Math.abs(latest.changePercent-.8)<1e-9);assert.ok(latest.latestChangePercent<0);assert.ok(latest.drawdownFromPeakPercent<0);
 assert.equal(trackingReview({record:{signalId:'SIM-1'},price:90000,track:btc}),null);
 assert.equal(trackingReview({...btc.events[0],track:btc}).latestChangePercent,null);
});

test('a full historical preview labels its plotted range separately from an earlier signal time',async()=>{
 const {signalHistoryPreview}=await import('./signal-tracking-view.mjs'),btc=TRACKING_CASES.find(c=>c.id==='BTC'),row={...btc.events[1],track:btc},before=JSON.stringify(btc);
 assert.equal(row.time,'10:53');const html=signalHistoryPreview(row);assert.match(html,/10:18\s*—\s*12:03/);assert.match(html,/记录走势|Recorded path/);assert.doesNotMatch(html,/10:53/);assert.equal(JSON.stringify(btc),before);assert.equal(row.time,'10:53');
});

test('historical detail explains its price path, verification gaps and risk without changing its original plan',async t=>{
 const h=await signalSelectionHarness(t,{count:0});h.open('TRACK-BTC-4');const aside=h.html().split('<aside class="sig-detail-aside">')[1],record=JSON.parse(h.source().text);
 assert.match(aside,/追踪脉络|Tracking path/);assert.match(aside,/继续核验|Verify next/);assert.match(aside,/风险与失效|Risk and invalidation/);assert.match(aside,/非交易收益|not trading returns/);
 assert.equal(record.price,81230);assert.equal(record.observedAt,'2026-10-24T12:03:00+08:00');assert.equal(record.plan,null);assert.equal(record.referencePlan.levels,null);assert.equal(record.review.observations,4);assert.equal(record.review.checks.length,2);
 const original=aside.split('<div class="sig-record-state">')[1].split('</details>')[0];assert.match(original,/失效条件.*未提供|Invalidation.*Not provided/);assert.doesNotMatch(original,/3R/);
 assert.doesNotMatch(aside,/data-track-reference-retry/,'missing historical inputs cannot be repaired by repeating the request');
});

test('historical cards expose a comparable price change while live records retain their missing-value state',async t=>{
 const h=await signalSelectionHarness(t,{order:'plans'}),cards=[...h.html().matchAll(/<article[\s\S]*?<\/article>/g)].map(m=>m[0]);
 const eth=cards.find(card=>card.includes('data-track-record="TRACK-ETH-4"')),btc=cards.find(card=>card.includes('data-track-record="TRACK-BTC-4"'));assert.match(eth,/较首次记录|From first record/);assert.ok(eth.includes('+1.20%'));assert.ok(btc.includes('+0.80%'));assert.match(eth,/sig-card-spark/);
 const run=cards.find(card=>card.includes(':SIG-3'));assert.doesNotMatch(run,/较首次记录|From first record|\+1.20%|sig-card-spark/);assert.match(run,/未提供|Not provided/);assert.match(run,/data-signal-density="compact"/);assert.match(run,/sig-card-price-missing/);
 const runText=run.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');assert.match(runText,/运行\s+RUN-1|Run\s+RUN-1/);assert.match(runText,/信号\s+SIG-3|Signal\s+SIG-3/);
});


test('reset controls restore tracking filters without changing business state',async()=>{
 const {createSignalTracker}=await import('./signal-tracking-view.mjs'),previous=globalThis.document;
 const resets=[{},{}],sources=[{dataset:{trackSource:'onchain'}}],root={querySelector(){return null;},querySelectorAll(selector){return selector==='[data-track-reset]'?resets:selector==='[data-track-source]'?sources:[];}};
 try{
  globalThis.document={body:{append(){}},createElement:()=>({setAttribute(){},addEventListener(){}})};
  const w={s:{aiSignalWatch:[],credits:600},touch(){throw new Error('Filtering must not mutate account state');}},before=JSON.stringify(w.s);
  const tracker=createSignalTracker({w,research:{tasks:[],accepts:()=>true,task:()=>null},root,refresh(){},onResearchReview(){},onBrowse(){}});
  const render=()=>tracker.render({nav:''});
  for(const reset of resets){tracker.bind();sources[0].onclick();assert.match(render(),/(?:运行记录|Run history) <b>0<\/b><\/span><span>(?:历史观察记录|Historical observations) <b>2<\/b><\/span>/);reset.onclick();assert.match(render(),/(?:运行记录|Run history) <b>0<\/b><\/span><span>(?:历史观察记录|Historical observations) <b>12<\/b><\/span>/);}
  assert.equal(JSON.stringify(w.s),before);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('research preferences validate saved values and filter only the requested market, information and defined strategy',()=>{
 const rows=trackingRows(TRACKING_CASES,{latestOnly:true}),before=JSON.stringify(rows);
 assert.deepEqual(signalPreferences({scope:'invalid',focus:'onchain',strategy:'RX03-S'}),{scope:'all',focus:'onchain',strategy:'RX03-S'});
 assert.equal(filterSignalPreferences(rows,{}).length,rows.length);
 assert.deepEqual(filterSignalPreferences(rows,{scope:'crypto',focus:'onchain',strategy:'RX03-S'}).map(x=>x.symbol),['ETH']);
 assert.ok(filterSignalPreferences(rows,{scope:'tradfi'}).every(x=>x.track.asset.domain!=='Crypto'));
 assert.equal(filterSignalPreferences(rows,{scope:'tradfi',strategy:'S00'}).length,0);
 assert.equal(JSON.stringify(rows),before);
});

test('research overlays retain each signal record date instead of a mode label',async()=>{
 const {createSignalTracker}=await import('./signal-tracking-view.mjs'),previous=globalThis.document;
 try{
  globalThis.document={body:{append(){}},createElement:()=>({setAttribute(){},addEventListener(){}})};
  const w={s:{aiSignalWatch:[],credits:600},touch(){throw Error('Rendering must not mutate account state');}};
  const view=createSignalTracker({w,root:{querySelector(){return null;},querySelectorAll(){return [];}},research:{tasks:[],accepts:()=>true,task:()=>({phase:'complete',title:'Research updated',thesis:'Review conditions',version:1})},refresh(){},onBrowse(){}});
  const html=view.render({nav:''});
  assert.equal((html.match(/class="sig-event-time"><time datetime="2026-/g)||[]).length,12);
  assert.doesNotMatch(html,/class="sig-event-time"><span>模拟<\/span>/);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('signal search finds visible strategy IDs, while unsupported assets remain actionable information rather than plans',async()=>{
 const {createSignalTracker}=await import('./signal-tracking-view.mjs'),old=globalThis.document,oldRAF=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=fn=>fn();
 const input={value:'',selectionStart:0,isConnected:true,addEventListener(type,fn){this['on'+type]=fn;},focus(){},setSelectionRange(){}},root={querySelector:q=>q==='#sig-search'?input:null,querySelectorAll:()=>[]};
 try{
  globalThis.document={body:{append(){}},createElement:()=>({setAttribute(){},addEventListener(){}})};
  const w={s:{aiSignalWatch:[],credits:600},touch(){throw Error('Search must not mutate business state');}},before=JSON.stringify(w.s),view=createSignalTracker({w,root,refresh(){},onBrowse(){}});
  assert.match(view.render({nav:''}),/(?:运行记录|Run history) <b>0<\/b><\/span><span>(?:历史观察记录|Historical observations) <b>12<\/b><\/span>/);assert.doesNotMatch(view.render({nav:''}),/份示例方案|方案优先|Plans first/);
  view.bind();input.value='RX03-S';input.oninput({});const result=view.render({nav:''});
  assert.match(result,/(?:运行记录|Run history) <b>0<\/b><\/span><span>(?:历史观察记录|Historical observations) <b>1<\/b><\/span>/);assert.match(result,/data-track-record="TRACK-ETH/);assert.doesNotMatch(result,/data-track-record="TRACK-BTC/);
  input.value='ETH';input.oninput({});assert.doesNotMatch(view.render({nav:''}),/data-track-record="TRACK-SUI/);
  input.value='SOL';input.oninput({});const observed=view.render({nav:''});assert.match(observed,/解读信号/);assert.doesNotMatch(observed,/查看线索|查看方案/);
  assert.equal(JSON.stringify(w.s),before);
  assert.match(view.render({nav:'',myWatch:true}),/还没有追踪的标的/);
 }finally{if(oldRAF===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=oldRAF;if(old===undefined)delete globalThis.document;else globalThis.document=old;}
});

test('research preferences survive stale workspace state and do not spend credits',async()=>{
 const {createSignalTracker}=await import('./signal-tracking-view.mjs'),oldDoc=globalThis.document,oldStorage=globalThis.localStorage,values=new Map();
 const control={dataset:{sigPref:'scope'},value:'tradfi'},root={querySelector(){return null;},querySelectorAll(q){return q==='[data-sig-pref]'?[control]:[];}};
 try{
  globalThis.document={body:{append(){}},createElement:()=>({setAttribute(){},addEventListener(){}})};
  globalThis.localStorage={getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,value)};
  const w={s:{credits:600},touch(){}},view=createSignalTracker({w,root,refresh(){},onBrowse(){}});view.bind();control.onchange();
  assert.deepEqual(JSON.parse(values.get('hive.ai-signal.preferences.v1')),{scope:'tradfi',focus:'all',strategy:'all'});
  w.s.aiSignalPreferences={scope:'all',focus:'all',strategy:'all'};
  assert.match(view.render({nav:''}),/(?:运行记录|Run history) <b>0<\/b><\/span><span>(?:历史观察记录|Historical observations) <b>3<\/b><\/span>/);assert.equal(w.s.aiSignalPreferences.scope,'tradfi');assert.equal(w.s.credits,600);
 }finally{if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;if(oldStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=oldStorage;}
});

test('historical topics expose library rules without fabricated entry, stop or target levels',()=>{
 for(const row of trackingRows(TRACKING_CASES,{latestOnly:true})){
  const p=signalReferencePlan(row);assert.equal(p.status,'pending');assert.equal(p.levels,null);
  if(signalStrategy(row.track)){assert.ok(p.rules);assert.ok(p.reasons.some(reason=>reason[0].includes('原记录未登记')));}
 }
});

test('signal filter and preference panels close each other, dismiss outside, and restore focus on Escape',async()=>{
 const {createSignalTracker}=await import('./signal-tracking-view.mjs'),old=globalThis.document,handlers={};let focused=0;
 const a={open:true,querySelector:()=>({focus(){focused++;}})},b={...a},panels=[a,b],root={querySelectorAll:()=>panels.filter(p=>p.open),querySelector:()=>panels.find(p=>p.open)};
 try{
  globalThis.document={body:{append(){}},createElement:()=>({setAttribute(){},addEventListener(){}}),addEventListener:(type,fn)=>handlers[type]=fn};
  createSignalTracker({w:{s:{},touch(){throw Error('Panel dismissal cannot change account state');}},root,refresh(){}});
  handlers.click({target:{closest:()=>b}});assert.equal(a.open,false);assert.equal(b.open,true);
  handlers.keydown({key:'Escape',preventDefault(){}});assert.equal(b.open,false);assert.equal(focused,1);
  a.open=b.open=true;handlers.click({target:{closest:()=>null}});assert.equal(a.open||b.open,false);
 }finally{if(old===undefined)delete globalThis.document;else globalThis.document=old;}
});

test('signal cards preserve next steps and start in recorded order without plan prioritization',async()=>{
 const {createSignalTracker}=await import('./signal-tracking-view.mjs'),old=globalThis.document;
 try{
  globalThis.document={body:{append(){}},createElement:()=>({setAttribute(){},addEventListener(){}})};
  const w={s:{},touch(){throw Error('Review must not mutate business state');}},view=createSignalTracker({w,root:{querySelector:()=>null,querySelectorAll:()=>[]},refresh(){}});
  view.select('ETH');const html=view.render({nav:''});assert.match(html,/href="\?page=markets&asset=ETH"/);assert.doesNotMatch(html,/data-track-trade|data-sig-sort|方案优先|查看方案|查看线索/);assert.match(html,/观察记录/);assert.match(html,/交叉确认/);assert.match(html,/信号解读/);assert.match(html,/交易参考/);assert.match(html,/待补依据/);
  assert.ok(html.indexOf('data-track-record="TRACK-XAU')<html.indexOf('data-track-record="TRACK-ETH'));
 }finally{if(old===undefined)delete globalThis.document;else globalThis.document=old;}
});

test('signal copy and readable report retain original prices, timeframe and conditions without business mutations',async t=>{
 const {createSignalTracker,signalCopyText,signalReportHTML}=await import('./signal-tracking-view.mjs');
 const {trackingRecord}=await import('./signal-tracking.mjs');
 const saved={document:globalThis.document,navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator'),localStorage:globalThis.localStorage,location:globalThis.location,matchMedia:globalThis.matchMedia};
 const buttons={copy:{dataset:{}},export:{dataset:{}}},dialog={setAttribute(){},addEventListener(){}},w={s:{signals:[],aiSignalWatch:[]},touch(){throw Error('No trade, billing or tracking mutation');}},root={querySelector:()=>null,querySelectorAll:s=>s==='[data-track-copy]'?[buttons.copy]:s==='[data-track-export]'?[buttons.export]:[]};
 let clipboard='',blob;const notices=[];
 try{
  globalThis.document={body:{append(){}},createElement:tag=>tag==='dialog'?dialog:{click(){}}};globalThis.localStorage={getItem:()=>null};globalThis.location={search:'?page=signals'};globalThis.matchMedia=()=>({matches:false});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{async writeText(text){clipboard=text;}}}});
  t.mock.method(URL,'createObjectURL',value=>{blob=value;return 'blob:test';});t.mock.method(URL,'revokeObjectURL',()=>{});
  const tracker=createSignalTracker({w,root,refresh(){},notify:(message,options)=>notices.push({message,...options}),readSnapshot:()=>({time:12})});tracker.select('ETH');const html=tracker.render({nav:''}),id=html.match(/data-track-copy="([^"]+)"/)[1];
  buttons.copy.dataset.trackCopy=id;buttons.export.dataset.trackExport=id;tracker.bind();const before=JSON.stringify(w.s);
  await buttons.copy.onclick();await buttons.export.onclick();
  assert.equal(notices.length,2);assert.match(notices[0].message,/已复制|Copied/);assert.match(notices[1].message,/已导出|Exported/);assert.ok(notices.every(notice=>notice.tone==='success'));
  const exported=await blob.text(),row=trackingRows(TRACKING_CASES,{latestOnly:true}).find(row=>row.id===id);assert.equal(blob.type,'text/html;charset=utf-8');assert.ok(exported.startsWith('<!doctype html>'));
  assert.equal(exported,signalReportHTML(row));assert.deepEqual(JSON.parse(tracker.sourceSnapshot().text),{...trackingRecord(row),quote:signalQuote(row),referencePlan:signalReferencePlan(row)});assert.equal(clipboard,signalCopyText(row));
  assert.ok(clipboard.includes('ETH'));assert.ok(clipboard.includes('RX03-S'));assert.ok(clipboard.includes('30m / 15m'));
  assert.ok(clipboard.includes('3,180'));assert.doesNotMatch(clipboard,/3,148\.2|3,243\.6/);assert.match(clipboard,/待补依据|Evidence pending/);
  assert.ok(clipboard.includes('2026-10-24'));assert.ok(clipboard.includes('12:10'));assert.ok(clipboard.includes('16'));assert.ok(clipboard.includes('15m'));
  assert.match(clipboard,/追踪脉络|Tracking path/);assert.ok(clipboard.includes('+1.20%'));assert.ok(clipboard.includes('-0.49%'));assert.match(clipboard,/非交易收益|not trading returns/);assert.match(clipboard,/净流入|net flows/);assert.match(clipboard,/转账不等于买入|Transfers are not purchases/);
  assert.doesNotMatch(clipboard,/[{}]|"sourceId"|"clockKind"/);assert.equal(JSON.stringify(w.s),before);
  const btc=trackingRows(TRACKING_CASES,{latestOnly:true}).find(row=>row.symbol==='BTC'),text=signalCopyText(btc);assert.ok(text.includes('4h / 1h / 15m'));assert.ok(text.includes('81,230'));assert.doesNotMatch(text,/80,316\.16|83,971\.51/);assert.match(text,/当时评分日志|Point-in-time scores/);
  navigator.clipboard.writeText=async()=>{throw Error('Clipboard permission denied');};await buttons.copy.onclick();assert.equal(notices.length,3);assert.equal(notices[2].tone,'error');assert.match(notices[2].message,/操作失败|Action failed/);assert.equal(JSON.stringify(w.s),before);
  const create=document.createElement;document.createElement=tag=>tag==='a'?{click(){throw Error('Download blocked');}}:create(tag);await buttons.export.onclick();assert.equal(notices.length,4);assert.equal(notices[3].tone,'error');assert.equal(JSON.stringify(w.s),before);
 }finally{for(const key of ['document','localStorage','location','matchMedia']){if(saved[key]===undefined)delete globalThis[key];else globalThis[key]=saved[key];}if(saved.navigator)Object.defineProperty(globalThis,'navigator',saved.navigator);else delete globalThis.navigator;}
});

function recommendationSignalRef(h,id){
 const r=publicRunSignals(h.w.s.signals,{time:100}).find(r=>r.signalId===id);assert.ok(r);
 return {type:'signal',recordId:[r.sourceId,r.version,r.runId,r.signalId].join(':'),sourceId:r.sourceId,signalId:r.signalId,runId:r.runId,revision:r.version,asset:r.instrument.symbol};
}
for(const compact of [false,true])test(`recommendation source opens an expired filtered record without changing the signal view (${compact?'mobile':'desktop'})`,async t=>{
 const h=await signalSelectionHarness(t,{count:20,compact}),ref=recommendationSignalRef(h,'SIG-1');assert.equal(typeof h.view.openSource,'function');
 h.w.s.signals[0].validUntil=1;h.w.s.aiSignalPreferences={scope:'tradfi',focus:'all',strategy:'all'};h.origin.value='historical';h.origin.onchange({target:h.origin});h.validity.value='active';h.validity.onchange({target:h.validity});
 const before=h.html(),state=JSON.stringify(h.w.s);h.root.scrollTop=342;document.body.dataset.page='strategies';let returned=0;
 assert.equal(h.view.openSource(ref,()=>{returned++;}),true);assert.equal(h.dialog.open,true);assert.match(h.dialog.innerHTML,/已过期|Expired/);assert.ok(h.dialog.innerHTML.includes('data-track-copy="'+ref.recordId+'"'));assert.equal(h.html(),before);assert.equal(h.root.scrollTop,342);assert.ok(h.watchRemoved()>0);
 if(compact)h.close.onclick();else h.dialogEvents.cancel({preventDefault(){}});
 assert.equal(h.dialog.open,false);assert.equal(returned,1);assert.equal(h.html(),before);assert.equal(h.root.scrollTop,342);assert.equal(JSON.stringify(h.w.s),state);
 h.close.onclick();assert.equal(returned,1);
});

test('recommendation source validates every identity field, refuses missing versions and never substitutes another run',async t=>{
 const h=await signalSelectionHarness(t),ref=recommendationSignalRef(h,'SIG-1');assert.equal(typeof h.view.openSource,'function');let returned=0;const onReturn=()=>returned++,before=h.html(),state=JSON.stringify(h.w.s);
 for(const key of Object.keys(ref))assert.equal(h.view.openSource({...ref,[key]:'mismatch'},onReturn),false,key);
 for(const invalid of [null,{}, {...ref,revision:null},{...ref,recordId:undefined}])assert.equal(h.view.openSource(invalid,onReturn),false);
 assert.equal(JSON.stringify(h.w.s),state);
 h.w.s.signals.push({...selectionSignal(1),runId:'RUN-OTHER'});h.w.s.signals=h.w.s.signals.filter(r=>r.runId==='RUN-OTHER'||r.id!=='SIG-1');
 assert.equal(h.view.openSource(ref,onReturn),false);assert.equal(h.dialog.open,false);assert.equal(returned,0);assert.equal(h.html(),before);assert.equal(h.notices.length,0);
 const other=recommendationSignalRef(h,'SIG-1'),show=h.dialog.showModal;h.dialog.showModal=()=>{throw Error('Cannot open');};assert.equal(h.view.openSource(other,onReturn),false);assert.equal(h.dialog.open,false);assert.equal(returned,0);h.dialog.showModal=show;
 assert.equal(h.view.openSource(other,onReturn),true);assert.equal(h.view.openSource(other,()=>assert.fail('An open modal must retain its return context')),false);h.close.onclick();assert.equal(returned,1);
});

test('a detached source copies and exports its own public record and returns through the same market context',async t=>{
 const h=await signalSelectionHarness(t),ref=recommendationSignalRef(h,'SIG-1');assert.equal(typeof h.view.openSource,'function');
 const previous={navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator'),create:URL.createObjectURL,revoke:URL.revokeObjectURL,timeout:globalThis.setTimeout},files=[],download={},create=document.createElement;let clipboard='',returned=0;
 t.after(()=>{if(previous.navigator)Object.defineProperty(globalThis,'navigator',previous.navigator);else delete globalThis.navigator;URL.createObjectURL=previous.create;URL.revokeObjectURL=previous.revoke;globalThis.setTimeout=previous.timeout;});
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>{clipboard=text;}}}});URL.createObjectURL=blob=>{files.push(blob);return 'blob:source';};URL.revokeObjectURL=()=>{};globalThis.setTimeout=fn=>{fn();return 0;};document.createElement=tag=>tag==='a'?{...download,click(){download.clicked=true;download.name=this.download;}}:create(tag);
 h.origin.value='historical';h.origin.onchange({target:h.origin});document.body.dataset.page='strategies';h.root.scrollTop=180;const before=h.html(),state=JSON.stringify(h.w.s);
 assert.equal(h.view.openSource(ref,()=>returned++),true);ref.recordId='changed-by-caller';await h.copy.onclick();await h.exportButton.onclick();
 assert.match(clipboard,/SIG-1/);assert.doesNotMatch(clipboard,/^\s*[\[{]/);const report=await files[0].text();assert.ok(report.startsWith('<!doctype html>'));assert.match(report,/SIG-1/);assert.equal(files[0].type,'text/html;charset=utf-8');assert.equal(download.name,'Astarter-ETH-SIG-1-report.html');assert.equal(download.clicked,true);
 h.link.onclick({preventDefault(){}});assert.equal(h.dialog.open,false);assert.equal(returned,0);assert.equal(h.returns[0](),true);assert.equal(h.dialog.open,true);assert.match(h.dialog.innerHTML,/SIG-1/);h.close.onclick();assert.equal(returned,1);assert.equal(h.html(),before);assert.equal(h.root.scrollTop,180);assert.equal(JSON.stringify(h.w.s),state);
});

test('a source removed during a related-data visit returns to its card without opening a replacement signal',async t=>{
 const h=await signalSelectionHarness(t),ref=recommendationSignalRef(h,'SIG-2');assert.equal(typeof h.view.openSource,'function');let returned=0;
 assert.equal(h.view.openSource(ref,()=>returned++),true);h.link.onclick({preventDefault(){}});h.w.s.signals=h.w.s.signals.filter(r=>r.id!=='SIG-2');assert.equal(h.returns[0](),false);assert.equal(returned,1);assert.equal(h.dialog.open,false);
});

test('readable signal reports keep original prices, assumptions, history and source without external resources',async()=>{
 const {signalReportHTML,signalCopyText}=await import('./signal-tracking-view.mjs'),row=trackingRows(TRACKING_CASES,{latestOnly:true}).find(row=>row.symbol==='ETH'),before=JSON.stringify(row);
 const html=signalReportHTML(row),text=signalCopyText(row);
 assert.ok(html.startsWith('<!doctype html>'));assert.match(html,/<meta charset="utf-8">/);assert.match(html,/@page\{size:A4/);assert.match(html,/Content-Security-Policy/);
 for(const value of ['ETH','3,180','RX03-S','30m / 15m','2026-10-24','12:10','TRACK-ETH','+1.20%','-0.49%']){assert.ok(html.includes(value),value);assert.ok(text.includes(value),value);}
 assert.match(html,/待补依据|Evidence pending/);assert.doesNotMatch(html,/3,148\.2|3,243\.6|0\.5%/);assert.match(html,/非交易收益|not trading returns/);assert.match(html,/转账不等于买入|Transfers are not purchases/);
 assert.equal((html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1].match(/<tr>/g)||[]).length,row.track.events.length);
 assert.doesNotMatch(html,/<(?:script|iframe|link|img)\b/i);assert.doesNotMatch(html,/\b(?:src|href)\s*=/i);assert.doesNotMatch(text,/^\s*[\[{]/);assert.equal(JSON.stringify(row),before);
});

test('run reports and copy are readable, escaped and limited to public signal fields',async()=>{
 const {signalReportHTML,signalCopyText}=await import('./signal-tracking-view.mjs');
 const record=publicRunSignals([{id:'SIG-77',runId:'RUN-2',sourceId:'research-ETH',version:'v1',market:'ETH/USDT',side:'buy',clockKind:'simulation',observedAt:5,accountId:'PRIVATE-ACCOUNT-FIXTURE',apiKey:'SECRET-KEY-FIXTURE'}],{time:12})[0];
 const row={record,track:{id:'ETH',asset:{domain:'Crypto',unit:'USDT'},events:[],record}},before=JSON.stringify(row),html=signalReportHTML(row),text=signalCopyText(row);
 for(const value of ['SIG-77','RUN-2','v1','ETH/USDT']){assert.ok(html.includes(value),value);assert.ok(text.includes(value),value);}
 assert.match(html,/未提供|Not provided/);assert.doesNotMatch(html,/<svg|PRIVATE-ACCOUNT-FIXTURE|SECRET-KEY-FIXTURE/);assert.doesNotMatch(text,/^\s*[\[{]/);assert.equal(JSON.stringify(row),before);
 const instrument={...row,record:{...record,instrument:{...record.instrument,profileId:'cex-spot',venue:'Binance',chainId:1}}};assert.ok(signalReportHTML(instrument).includes('市场分类'));assert.ok(signalCopyText(instrument).includes('市场分类: cex-spot'));
 assert.doesNotThrow(()=>signalReportHTML({...row,record:{...record,clockKind:'wall',observedAt:1e20}}));
 const tiny={...row,record:{...record,price:1.23e-10}};assert.ok(signalReportHTML(tiny).includes('0.000000000123 USDT'));assert.ok(signalCopyText(tiny).includes('0.000000000123 USDT'));
 const attack={...row,record:{...record,condition:'<img src=x onerror="alert(1)">',invalidation:'</p><script>alert(2)</script>',sourceId:'source"><img src=x>',apiKey:'EXTRA-SECRET-FIXTURE'},track:{...row.track,title:['<b>恶意标题</b>','<b>title</b>']}};
 const escaped=signalReportHTML(attack);assert.ok(escaped.includes('&lt;img'));assert.ok(escaped.includes('&lt;script'));assert.ok(escaped.includes('&lt;b&gt;'));assert.ok(escaped.includes('&quot;'));
 assert.doesNotMatch(escaped,/<(?:script|img)\b|onerror="|EXTRA-SECRET-FIXTURE/i);
});

test('exporting an earlier observation never includes later history or changes the source record',async()=>{
 const {signalReportHTML}=await import('./signal-tracking-view.mjs'),btc=TRACKING_CASES.find(c=>c.id==='BTC'),row={...btc.events[1],track:btc},before=JSON.stringify(btc),html=signalReportHTML(row);
 const body=html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];assert.ok(body);assert.equal((body.match(/<tr>/g)||[]).length,2);assert.ok(body.includes(btc.events[1].time));
 assert.ok(!body.includes(btc.events.at(-1).date+' '+btc.events.at(-1).time+' UTC+8'));assert.equal(JSON.stringify(btc),before);
});


test('watchlist signals count matching assets once, preserve CA identity and open the shared manager',async()=>{
 const {createSignalTracker}=await import('./signal-tracking-view.mjs'),previous=globalThis.document,manager={};let opened=0;
 const ca='ca:base:0x'+'1'.repeat(40),w={s:{aiSignalWatch:['BTC','coin:bitcoin','coin:other-btc',ca],credits:600},touch(){throw Error('Reading a watchlist must not save it');}};
 const root={querySelector:()=>null,querySelectorAll:selector=>selector==='[data-track-manage]'?[manager]:[]};
 try{
  globalThis.document={body:{append(){}},createElement:()=>({setAttribute(){},addEventListener(){}})};
  const view=createSignalTracker({w,root,refresh(){},onManageWatch:()=>opened++}),before=JSON.stringify(w.s),html=view.render({nav:'',myWatch:true});
  assert.equal(view.watchCount(),1);assert.match(html,/data-track-record="TRACK-BTC/);assert.doesNotMatch(html,/data-track-record="TRACK-ETH/);assert.match(html,/data-track-manage/);
  view.bind();manager.onclick();assert.equal(opened,1);assert.equal(JSON.stringify(w.s),before);
  w.s.aiSignalWatch=[ca];assert.equal(view.watchCount(),0);assert.match(view.render({nav:'',myWatch:true}),/追踪标的暂无匹配信号/);
  w.s.aiSignalWatch=[];assert.match(view.render({nav:'',myWatch:true}),/还没有追踪的标的/);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('leaving Signals releases the unmounted chart roots and their hosts while the kept dispose stays callable',async t=>{
 const {build}=await import('esbuild'),{fileURLToPath}=await import('node:url'),{queryObjects}=await import('node:v8');
 const stubs={'react-dom/client':'export const createRoot=host=>({host,render(){host.log.push("render");},unmount(){host.log.push("unmount");}});','react-dom':'export const flushSync=paint=>paint();','./advanced-stats.jsx':'export const AdvancedStats=()=>null;'};
 const result=await build({entryPoints:[fileURLToPath(new URL('./signal-stats/entry.jsx',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',packages:'external',jsx:'automatic',logLevel:'silent',
  plugins:[{name:'chart-stubs',setup(b){b.onResolve({filter:/^(react-dom(\/client)?|\.\/advanced-stats\.jsx)$/},args=>({path:args.path,namespace:'chart-stub'}));b.onLoad({filter:/.*/,namespace:'chart-stub'},args=>({contents:stubs[args.path],loader:'js'}));}}]});
 const code=result.outputFiles[0].text.replace(/from (["'])([^"']+)\1/g,(_match,_quote,specifier)=>'from '+JSON.stringify(import.meta.resolve(specifier)));
 const {mountAdvancedStats}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const observers=[],log=[];
 for(const [key,value] of Object.entries({document:{documentElement:{dataset:{}}},MutationObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.closed=true;}}})){
  const own=Object.getOwnPropertyDescriptor(globalThis,key);globalThis[key]=value;t.after(()=>{if(own)Object.defineProperty(globalThis,key,own);else delete globalThis[key];});
 }
 class StatsHost{constructor(id){this.dataset={signalStats:id};this.isConnected=true;this.log=log;}}
 // Signals paints two chart hosts, then a route change replaces the page; the tracker keeps the returned function as disposeStats.
 const leaveSignals=()=>{
  let hosts=['SIG-1','SIG-2'].map(id=>new StatsHost(id));
  const dispose=mountAdvancedStats({hidden:false,parentNode:null,querySelectorAll:()=>hosts},new Map(hosts.map(host=>[host.dataset.signalStats,{id:host.dataset.signalStats}])));
  for(const host of hosts)host.isConnected=false;hosts=[];observers[0].callback([{type:'childList'}]);
  return dispose;
 };
 const disposeStats=leaveSignals();
 assert.deepEqual(log,['render','render','unmount','unmount']);assert.equal(observers[0].closed,true);
 assert.equal(queryObjects(StatsHost,{format:'count'}),0);
 disposeStats();assert.equal(log.length,4);
});
