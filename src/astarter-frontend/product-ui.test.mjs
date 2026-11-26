import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConnections,connectionIssue,connectionSummary} from './connections.mjs?v=20261120c';
import {windowRange,seriesDomain,makeBars,chartGesture} from './product-chart-ui.mjs';
import {candlestickChart} from './product-charts.mjs';
import {marketSeries} from './product-data.mjs';
test('app routing preserves modified clicks, middle clicks and previously handled links',async()=>{
 const {interceptNavigation}=await import('./product-layout.mjs');
 for(const native of [{metaKey:true},{ctrlKey:true},{shiftKey:true},{altKey:true},{button:1},{defaultPrevented:true}]){
  const event={button:0,...native,preventDefault:()=>assert.fail('native activation was intercepted')};
  assert.equal(interceptNavigation(event),false);
 }
 const primary={button:0,preventDefault(){this.defaultPrevented=true;}};
 assert.equal(interceptNavigation(primary),true);assert.equal(primary.defaultPrevented,true);
});
test('pages without section navigation keep their heading and bound actions after shared layout',async()=>{
 const {unifyProductLayout}=await import('./product-layout.mjs');
 const element=()=>({children:[],dataset:{},classes:new Set(),attributes:new Map(),
  get classList(){return {add:value=>this.classes.add(value),contains:value=>this.classes.has(value)};},
  append(...nodes){for(const node of nodes){node.remove();node.parent=this;this.children.push(node);}},
  prepend(node){node.remove();node.parent=this;this.children.unshift(node);},
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;},
  contains(node){return this.children.some(child=>child===node||child.contains(node));},
  querySelector(){return null;},querySelectorAll(){return [];},setAttribute(key,value){this.attributes.set(key,value);}
 });
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 try{
  globalThis.document={createElement:element};
  for(const page of ['profile','assets','settings']){
   const root=element(),head=element(),group=element(),title=element(),action=element();let clicks=0;
   title.textContent=page;action.onclick=()=>clicks++;group.append(title);head.append(group,action);root.append(head);
   head.querySelector=selector=>selector==='h1'?title:null;
   root.querySelector=selector=>selector==='.layout-page-head'&&head.classes.has('layout-page-head')?head:null;
   root.querySelectorAll=selector=>selector.includes('.page-head')?[head]:[];
   assert.doesNotThrow(()=>unifyProductLayout(root,page),page);
   assert.equal(root.dataset.layout,'unified');assert.equal(root.children[0],head);
   assert.equal(group.children[0],title);assert.equal(head.children.length,2);
   assert.equal(head.children[1].children[0],action);action.onclick();assert.equal(clicks,1);
   unifyProductLayout(root,page);assert.equal(head.children.length,2,'repeat render must not duplicate actions');
  }
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;}
});
test('data receipts paint under a closed data filter and wait during an open menu or a moving selection',async t=>{
 const {canAutoRefresh}=await import('./product-composition.mjs');
 const original=globalThis.document; t.after(()=>{if(original)globalThis.document=original;else delete globalThis.document;});
 let floating=false,gliding=false,filter='data-dc-route-select',native=false;
 const host={querySelector:selector=>filter&&selector.includes('['+filter+']')?{}:null};
 const activeElement={get tagName(){return native?'SELECT':'BUTTON';},matches:selector=>native?selector.includes('select['+filter+']')||selector.split(',').includes('select'):selector.includes('.lq-select__trigger'),closest:()=>host};
 globalThis.document={activeElement,querySelector:()=>floating?{}:null};
 const root={querySelector:selector=>gliding&&selector.includes('.layout-tab-glide')?{}:null,querySelectorAll:()=>[],contains:()=>true};
 assert.equal(canAutoRefresh(root),true);
 filter='data-pd-social-filter';
 assert.equal(canAutoRefresh(root),true,'receipts can render with focus on the saved news social filter');
 floating=true;assert.equal(canAutoRefresh(root),false);
 floating=false;gliding=true;assert.equal(canAutoRefresh(root),false);
 gliding=false;native=true;
 assert.equal(canAutoRefresh(root),true,'the native social filter can receive results while focused');
 native=false;filter='data-account-choice';
 assert.equal(canAutoRefresh(root),false,'other focused forms retain their existing refresh protection');
});
test('data refresh controls preserve owner bindings, busy state and the selected shared interval',async()=>{
 const {dataRefreshControls}=await import('./product-composition.mjs');
 for(const scope of ['dc','hub','pd']){
  const html=dataRefreshControls({scope,seconds:60,intervals:[15,30,60],busy:true,label:'<Reading>'});
  assert.match(html,new RegExp(`data-${scope}-refresh aria-busy="true" disabled`));
  assert.match(html,new RegExp(`data-${scope}-interval`));
  assert.match(html,/value="60" selected/);assert.match(html,/&lt;Reading&gt;/);
 }
 assert.throws(()=>dataRefreshControls({scope:'unknown',seconds:60,intervals:[60]}),/INVALID_DATA_REFRESH_SCOPE/);
});
test('shared card edges follow only the nearest framed card and clear on navigation, scroll and reduced motion',async()=>{
 const {bindCardEdges}=await import('./product-composition.mjs');
 const emitter=()=>{const listeners=new Map();return {addEventListener(type,fn){const list=listeners.get(type)||[];list.push(fn);listeners.set(type,list);},emit(type,event={}){for(const fn of listeners.get(type)||[])fn(event);}};};
 const root=emitter(),view=emitter(),media={...emitter(),matches:false},frames=new Map();let nextFrame=0,state;
 root.body={getAttribute:()=> 'signals'};root.documentElement={dataset:{},getAttribute:()=>root.documentElement.dataset.reducedMotion||null};
 const card=()=>{const attrs=new Set(),styles=new Map();return {isConnected:true,border:'1px',attrs,styles,setAttribute:key=>attrs.add(key),removeAttribute:key=>attrs.delete(key),getBoundingClientRect:()=>({left:10,top:20,width:200,height:100}),style:{setProperty:(key,value)=>styles.set(key,value)}};};
 const first=card(),nested=card(),target=element=>({closest:selector=>{assert.match(selector,/\.insight-surface/);assert.match(selector,/:not\(button,a,dialog,\.bh-root \*\)/);return element;}});
 const replacements={window:view,matchMedia:()=>media,getComputedStyle:element=>({borderTopWidth:element.border}),requestAnimationFrame:fn=>{frames.set(++nextFrame,fn);return nextFrame;},cancelAnimationFrame:id=>frames.delete(id),MutationObserver:class{constructor(fn){state=fn;}observe(){}}};
 const previous=new Map(Object.keys(replacements).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const flush=()=>{const pending=[...frames.values()];frames.clear();for(const fn of pending)fn();};
 const move=(element,extra={})=>root.emit('pointermove',{target:target(element),pointerType:'mouse',clientX:30,clientY:50,...extra});
 try{
  Object.assign(globalThis,replacements);bindCardEdges(root);
  move(first);move(first,{clientX:42});assert.equal(frames.size,1);flush();
  assert.equal(first.styles.get('--surface-x'),'32px');assert.equal(first.styles.get('--surface-y'),'30px');assert.equal(first.attrs.has('data-pointer'),true);assert.equal(frames.size,0);
  move(nested);assert.equal(first.attrs.has('data-pointer'),false);flush();assert.equal(nested.attrs.has('data-pointer'),true);
  move(first,{clientX:5});flush();assert.equal(first.attrs.has('data-pointer'),false,'a card shifted away before paint must not retain the edge');
  nested.border='0px';nested.parentElement=target(first);move(nested);flush();assert.equal(first.attrs.has('data-pointer'),true);assert.equal(nested.attrs.has('data-pointer'),false);nested.border='1px';delete nested.parentElement;move(nested);flush();
  for(const type of ['scroll','pointerleave','visibilitychange']){root.emit(type);assert.equal(nested.attrs.has('data-pointer'),false);move(nested);flush();}
  state([{target:root.body,attributeName:'data-page',oldValue:'signals'}]);assert.equal(nested.attrs.has('data-pointer'),true);
  state([{target:root.body,attributeName:'data-page',oldValue:'markets'}]);assert.equal(nested.attrs.has('data-pointer'),false);
  move(first);root.documentElement.dataset.reducedMotion='true';state([{target:root.documentElement,attributeName:'data-reduced-motion',oldValue:null}]);assert.equal(frames.size,0);
  move(first);assert.equal(frames.size,0);delete root.documentElement.dataset.reducedMotion;
  move(first);flush();media.matches=true;media.emit('change');assert.equal(first.attrs.has('data-pointer'),false);move(first);assert.equal(frames.size,0);media.matches=false;
  move(first,{pointerType:'touch'});assert.equal(frames.size,0);first.border='0px';move(first);assert.equal(frames.size,0);first.border='1px';
  move(first);first.isConnected=false;flush();assert.equal(first.attrs.has('data-pointer'),false);first.isConnected=true;
  root.emit('focusin',{target:target(first)});assert.equal(first.attrs.has('data-card-edge'),true);assert.equal(first.attrs.has('data-pointer'),false);assert.equal(frames.size,0);
  move(first);view.emit('pagehide');assert.equal(frames.size,0);assert.equal(first.attrs.has('data-pointer'),false);
 }finally{for(const [key,descriptor]of previous)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
});
import {marketView,feedView,strategyView,assetsView,logsView,tradeAnalytics} from './product-views.mjs';
import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';
import {validChartRecords,chartEngineOptions} from './product-chart-engine.mjs';
test('concise settings retain provider charges and storage errors',async()=>{
 const {settingsExperience}=await import('./product-experience.mjs');
 const preferences={},w={persistenceError:''},desk={snapshot:()=>({connections:{preferences}})};
 const official=settingsExperience({w,desk});
 assert.match(official,/调用消耗数据积分|calls use data credits/);
 assert.doesNotMatch(official,/均衡、极速、自适应，按任务选择|Balanced, fast or adaptive to fit the task/);
 preferences.data={source:'custom'};preferences.ai={source:'custom'};
 const before=structuredClone(preferences),custom=settingsExperience({w,desk});
 assert.match(custom,/数据调用积分 0|0 data call credits/);
 assert.match(custom,/模型调用积分 0|0 model call credits/);
 assert.deepEqual(preferences,before);
 w.persistenceError='Storage unavailable <retry>';
 assert.match(settingsExperience({w,desk}),/role="status">Storage unavailable &lt;retry&gt;/);
});

test('settings expose a recoverable page companion preference outside connection permissions',async()=>{
 const {settingsExperience}=await import('./product-experience.mjs');
 const connections={preferences:{}},before=structuredClone(connections),html=settingsExperience({w:{},desk:{snapshot:()=>({connections})}});
 assert.match(html,/id="ux-appearance"/);assert.match(html,/href="#ux-appearance"/);
 assert.match(html,/<button[^>]*role="switch"[^>]*data-companion-enabled/);
 assert.match(html,/aria-describedby="companion-setting-description"/);assert.deepEqual(connections,before);
});
test('settings report the preferred connection instead of borrowing legacy readiness',async()=>{
 const {settingsExperience}=await import('./product-experience.mjs');
 const {TradingAccess}=await import('./trading-access.mjs?v=20261120c');
 const c=normalizeConnections({exchange:true,data:true,ai:true,preferences:{exchange:{service:'binance',market:'spot',access:'trade'}},tradingAccounts:[{id:'preferred-api',kind:'exchange',service:'binance',market:'spot',access:'trade',label:'Primary API',accountId:'SIM-01'},{id:'preferred-wallet',kind:'wallet',service:'metamask',chain:'42161',network:'evm',venue:'wallet',access:'read',label:'Research wallet',accountId:'SIM-01'}],preferredTradingConnection:'preferred-api'});
 const runtime=new TradingAccess(c),stream={scope:{accountId:'SIM-01',environment:'DEMO'},state:'LIVE',generation:1},requests=[],desk={snapshot:()=>({connections:c}),access:options=>{requests.push(options);return runtime.status(stream,{profileId:'cex-spot',...options});}},w={};
 assert.equal(runtime.status(stream,{profileId:'cex-spot',operation:'entry'}).ready,true);
 const before=structuredClone(c),html=settingsExperience({w,desk});
 assert.deepEqual(requests,[{connectionId:'preferred-api',profileId:'cex-spot'}]);
 assert.match(html,/data-access-code="connection-unchecked"/);assert.match(html,/data-connection-id="preferred-api"/);assert.match(html,/Primary API/);assert.deepEqual(c,before);
 c.preferredTradingConnection='preferred-wallet';requests.length=0;
 const wallet=settingsExperience({w,desk});assert.deepEqual(requests,[{connectionId:'preferred-wallet',profileId:'dex-spot'}]);assert.match(wallet,/data-connection-open="wallet"/);
 c.preferredTradingConnection='';requests.length=0;
 const empty=settingsExperience({w,desk});assert.equal(requests.length,0);assert.doesNotMatch(empty,/data-access-code="ready"/);assert.match(empty,/未选择|Not selected/);
});
test('account chart labels explain elapsed time without changing ledger values or inventing calendar dates',()=>{
 const data={cash:9999,position:null,orders:[],flow:{fills:[],reservations:[],ledger:[{type:'FEE',amount:-1,at:660.9}]}},before=structuredClone(data);
 const analytics=tradeAnalytics(data);
 assert.deepEqual(analytics.history,[10000,9999]);assert.equal(analytics.reconciles,true);
 assert.match(analytics.labels.at(-1),/11分0秒|11m 0s/);assert.equal(analytics.labels.at(-1).includes('T+'),false);
 assert.deepEqual(data,before);
});
test('simplified setup retains every money and budget field without mutating the saved mandate',async()=>{
 const {setupView}=await import('./setup-view.mjs'),{WorkspaceSim}=await import('./workspace-sim.mjs');
 const workspace=new WorkspaceSim(),before=structuredClone(workspace.s),html=setupView(workspace,3);
 for(const name of ['amount','strategyCap','dailyLoss','cap','daily'])assert.equal((html.match(new RegExp(`name="${name}"`,'g'))||[]).length,1,name);
 const advanced=html.match(/<details class="setup-advanced">([\s\S]*?)<\/details>/)?.[1];
 assert.ok(advanced);assert.match(advanced,/name="cap"/);assert.match(advanced,/name="daily"/);
 assert.equal(advanced.includes('name="amount"'),false);assert.deepEqual(workspace.s,before);
 assert.equal(setupView(workspace,2).includes('由你确认'),false);
});
test('setup shows an access recovery action before allowing checks and keeps signal-only access separate',async()=>{
 const {setupView}=await import('./setup-view.mjs'),{WorkspaceSim}=await import('./workspace-sim.mjs');
 const workspace=new WorkspaceSim(),requests=[];
 workspace.tradingAccess=options=>{requests.push(options);return {code:'read-only',ready:false,accountId:'SIM-01',profileId:'cex-spot'};};
 const html=setupView(workspace,4);
 assert.match(html,/data-access-action="enable-trade"/);
 assert.match(html,/data-biz="setup-validate"[^>]*disabled/);
 assert.ok(requests.some(request=>request.operation==='entry'));
 requests.length=0;workspace.draft().mode='signal';setupView(workspace,4);
 assert.ok(requests.some(request=>request.operation==='observe'));
});
test('desktop toolbar does not block data paint; floating menus and focused inputs still do',async()=>{
 const {canAutoRefresh}=await import('./product-composition.mjs');
 const previous=globalThis.document;let floating=false,focused=false;
 const root={querySelector:selector=>selector.includes('details.layout-actions-menu[open]')||floating&&selector.includes('details[data-info-open]')?{}:null,querySelectorAll:()=>[],contains:()=>focused};
 try{
  globalThis.document={activeElement:{matches:()=>true},querySelector:()=>null};
  assert.equal(canAutoRefresh(root),true);
  floating=true;assert.equal(canAutoRefresh(root),false);
  floating=false;focused=true;assert.equal(canAutoRefresh(root),false);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
test('saved connection preferences ignore secrets and cannot restore wallet authority',()=>{
 const d=normalizeConnections({exchange:false,wallet:true,provider:'invalid',budget:-1,secret:'not-stored'});
 assert.equal(d.exchange,false);assert.equal(d.wallet,false);assert.equal(d.provider,'Astarter');assert.equal(d.budget,5);assert.equal('secret' in d,false);
 assert.deepEqual(connectionSummary(d),{ready:2,total:3,complete:false});assert.ok(connectionIssue({...d,budget:101}));assert.ok(connectionIssue({...d,budget:NaN}));assert.equal(connectionIssue({...d,budget:8}),null);
});
test('chart windows clamp at both ends and zoom does not change source data',()=>{
 const values=marketSeries('BTC'),before=JSON.stringify(values);
 assert.deepEqual(windowRange(60,-20,20),{start:0,count:20});assert.deepEqual(windowRange(60,57,20),{start:40,count:20});assert.deepEqual(windowRange(60,0,3),{start:0,count:8});assert.deepEqual(windowRange(2,0,30),{start:0,count:2});assert.equal(JSON.stringify(values),before);
});
test('chart gestures leave vertical reading scrolls to the page and ignore tap jitter',()=>{
 assert.equal(chartGesture(2,3),'pending');
 assert.equal(chartGesture(4,28),'scroll');
 assert.equal(chartGesture(-5,-32),'scroll');
 assert.equal(chartGesture(28,4),'pan');
 assert.equal(chartGesture(-32,5),'pan');
});
test('native chart options preserve source OHLC and missing volume while linking both time axes',async()=>{
 const data=[{time:1,open:10,close:12,low:9,high:13,volume:20},{time:2,open:12,close:11,low:10,high:14,volume:null}],before=structuredClone(data);
 const palette={ink:'#111',muted:'#888',line:'#ddd',panel:'#fff',up:'#0a7',down:'#d43',accent:'#75f',font:'sans-serif'},format={label:String,axis:String,value:String};
 const c={data,kind:'candle',title:'OHLC',scale:'linear'},option=chartEngineOptions(c,palette,format);
 assert.equal(validChartRecords(c),true);assert.deepEqual(option.series[0].data,[[10,12,9,13],[12,11,10,14]]);
 assert.equal(option.series[1].data[1].value,null);assert.deepEqual(option.dataZoom[0].xAxisIndex,[0,1]);assert.deepEqual(option.axisPointer.link,[{xAxisIndex:'all'}]);
 assert.equal(option.dataZoom[0].zoomOnMouseWheel,'ctrl');assert.equal(option.dataZoom[0].moveOnMouseWheel,false);assert.equal(option.dataZoom[0].preventDefaultMouseMove,false);
 const {init}=await import('echarts');const chart=init(null,null,{renderer:'svg',ssr:true,width:360,height:320});
 try{chart.setOption(option);const svg=chart.renderToSVGString();assert.match(svg,/<svg/);assert.equal(svg.includes('NaN'),false);}finally{chart.dispose();}
 assert.deepEqual(data,before);assert.equal(validChartRecords({...c,data:[{...data[0],low:11}]}),false);
});
test('chart validation rejects missing values and negative-bar axes retain a zero baseline',()=>{
 const palette={ink:'#111',muted:'#888',line:'#ddd',panel:'#fff',up:'#0a7',down:'#d43',accent:'#75f',font:'sans-serif'},format={label:String,axis:String,value:String};
 const c={data:[{time:'sample A',value:-2},{time:'sample B',value:8}],kind:'bar',title:'Net flow',scale:'linear'},option=chartEngineOptions(c,palette,format);
 assert.equal(option.yAxis.scale,false);assert.equal(option.xAxis.axisLabel.formatter(1),'sample B');assert.equal(option.series[0].data[0].itemStyle.color,palette.down);
 assert.equal(validChartRecords({...c,data:[{value:null}]}),false);assert.equal(validChartRecords({...c,data:[{value:NaN}]}),false);assert.equal(validChartRecords({...c,data:[]}),false);
 assert.equal(chartEngineOptions({...c,kind:'line',scale:'log'},palette,format).yAxis.type,'value');
 assert.equal(chartEngineOptions({...c,kind:'line',scale:'log',data:[{value:2},{value:4}]},palette,format).yAxis.type,'log');
});
test('narrow candle viewports preserve every source bar and its close value',()=>{
 const bars=makeBars(marketSeries('BTC'));
 const before=JSON.stringify(bars),html=candlestickChart(bars,{width:248,height:320});
 assert.match(html,/viewBox="0 0 248 320"/);
 assert.equal((html.match(/data-index=/g)||[]).length,bars.length);
 assert.ok(html.includes(`data-close="${bars.at(-1).close}"`));
 assert.equal(JSON.stringify(bars),before);
});
test('OHLC periods carry valid envelopes and correct time spacing',()=>{
 for(const [period,hours]of [['1H',1],['4H',4],['1D',24]]){const bars=makeBars(marketSeries('BTC',period),period);assert.equal(bars.length,60);assert.equal(bars[1].time-bars[0].time,hours*3600000);assert.ok(bars.every(b=>b.high>=Math.max(b.open,b.close)&&b.low<=Math.min(b.open,b.close)));}
 assert.deepEqual(seriesDomain([],true),[0,1]);const [min,max]=seriesDomain([-2,8],true);assert.ok(min<0&&max>8);const flat=seriesDomain([10000,10000]);assert.ok(flat[0]<10000&&flat[1]>10000);
});
test('all new data views render empty and configured states without fabricated trades',()=>{
 const d=new TradingDemo(),before=JSON.stringify(d);
 const market=marketView({domain:'TradFi',symbol:'US10Y',period:'4H',metric:'主力成本'});
 for(const html of [market,feedView({kind:'tracking',rows:[],watched:[],filter:'全部',query:''}),strategyView({filter:'我的草稿',drafts:[],query:''}),assetsView({d,equityHistory:[10000]}),logsView({d,rows:[],filter:'全部'})]){assert.ok(html.length>400);assert.equal(html.includes('NaN'),false);}
 assert.ok(market.includes('指标定义'));assert.ok(market.includes('来源可信度'));assert.ok(market.includes('当前样本不提供此指标'));
 assert.equal(JSON.stringify(d),before);
});
test('asset and order views use the same partial-fill ledger, including fees',()=>{
 const d=new TradingDemo();d.start({market:'BTC/USDT',strategy:'S03',mode:'confirm',amount:100,cap:500},normalizeConnections(),{ready:true,market:'BTC/USDT',price:80000,revision:'r1'});d.tick(.2);d.signal={side:'buy',at:0,id:'S-1'};d.submit();d.fill(d.pending,.5);
 const assets=assetsView({d,equityHistory:[10000,d.equity]}),logs=logsView({d,rows:d.orders,filter:'全部'});
 assert.ok(assets.includes('9,949.95'));assert.ok(assets.includes('0.00062500'));assert.ok(logs.includes(d.orders[0].id));assert.ok(logs.includes('0.0500'));
});

test('narrow chart axes reduce labels while retaining correct data positions',async()=>{
 const {chartAxisTicks}=await import('./product-chart-ui.mjs');
 const labels=['10-22 00:00','10-23 00:00','10-24 00:00'];
 const ticks=chartAxisTicks(labels,160,3);assert.equal(ticks.length,2);
 assert.equal(ticks[0].index,0);assert.equal(ticks.at(-1).index,2);
 for(const tick of ticks)assert.equal(tick.x,tick.index/2*160);
 const short=chartAxisTicks(['11:35','12:10','12:45','13:20','13:55'],150,3);
 assert.equal(short.length,3);assert.equal(short[1].label,'12:45');
 assert.deepEqual(chartAxisTicks([],150),[]);
});

// A dirty form must remain intact when focus moves from the field to Save.
test('automatic refresh identifies unsaved values and untouched defaults', async()=>{
 const {hasUnsavedFields}=await import('./product-composition.mjs');
 const root=fields=>({querySelectorAll:()=>fields});
 const amount={tagName:'INPUT',type:'number',value:'200',defaultValue:'200'};
 assert.equal(hasUnsavedFields(root([amount])),false);
 assert.equal(hasUnsavedFields(root([{...amount,value:'229'}])),true);
 assert.equal(hasUnsavedFields(root([{tagName:'INPUT',type:'checkbox',checked:true,defaultChecked:false}])),true);
 assert.equal(hasUnsavedFields(root([{...amount,value:'229',disabled:true}])),false);
 const options=[{selected:true,defaultSelected:false},{selected:false,defaultSelected:false}];
 assert.equal(hasUnsavedFields(root([{tagName:'SELECT',type:'select-one',multiple:false,options}])),false);
 assert.equal(hasUnsavedFields(root([{tagName:'SELECT',type:'select-one',multiple:false,options:[{selected:false,defaultSelected:true},{selected:true,defaultSelected:false}]}])),true);
});

test('execution details stay inside the run and never leak into an unavailable account',async()=>{
 const {executionView}=await import('./execution-views.mjs');
 const {DEFAULT_SCOPE}=await import('./execution-stream.mjs');
 const d=new TradingDemo();assert.equal(d.start({market:'BTC/USDT',strategy:'S03',mode:'signal',amount:100,cap:500},DEFAULT_CONNECTIONS,{ready:true,market:'BTC/USDT'}),null);
 const before=JSON.stringify(d),status={state:'LIVE',scope:DEFAULT_SCOPE,lastSyncedAt:0};
 const details='<div data-test-trade-details>Exit conditions</div>';
 const html=executionView({data:d,status,tradeDetails:details});
 const section=html.match(new RegExp(`<section\\b[^>]*class="contract-run"[^>]*data-run="${d.session.id}"[^>]*>`));
 assert.ok(section,'the details must belong to this exact run');
 const run=section.index,detail=html.indexOf('data-test-trade-details');
 assert.ok(detail>run&&detail<html.indexOf('</section>',run));
 const unavailable=executionView({data:null,status:{...status,state:'BLOCKED',scope:{...DEFAULT_SCOPE,accountId:'SIM-02'}},tradeDetails:details});
 assert.equal(unavailable.includes('data-test-trade-details'),false);
 assert.equal(unavailable.includes('data-biz="trade"'),false);
 assert.equal(JSON.stringify(d),before);
});

test('unavailable account has one recovery action and hides the other account trade data',async()=>{
 const {executionView}=await import('./execution-views.mjs'),{DEFAULT_SCOPE}=await import('./execution-stream.mjs');
 const status={state:'BLOCKED',scope:{...DEFAULT_SCOPE,accountId:'SIM-02'},lastSyncedAt:null,access:{code:'other-account',ready:false,accountId:'SIM-02',profileId:'cex-spot'}};
 const before=structuredClone(status),html=executionView({data:null,status});
 assert.equal((html.match(/data-access-action="use-demo"/g)||[]).length,1);
 assert.doesNotMatch(html,/data-biz="connections"|execution-position|data-biz="trade"/);
 assert.deepEqual(status,before);
});

test('the current trade path never borrows a plan from an earlier run or signal',async()=>{
 const {chainPanel}=await import('./execution-views.mjs');
 const {ExecutionRecords}=await import('./execution-records.mjs');
 const records=new ExecutionRecords();
 const oldSession={id:'OLD-RUN',market:'ETH/USDT',price:3000,strategy:'S03',amount:100,cap:500};
 const current={...oldSession,id:'CURRENT-RUN',mode:'confirm'};
 records.prepare({id:'OLD-SIGNAL',side:'sell'},oldSession,.03,'normal',1);
 const d={session:current,signal:{id:'CURRENT-SIGNAL',side:'buy'},orders:[],flow:records.data};
 const before=JSON.stringify(d);
 let html=chainPanel(d);
 assert.equal(html.includes('OLD-SIGNAL'),false);
 assert.match(html,/还没下单|还没有提交/);
 records.prepare({id:'PREVIOUS-IN-CURRENT-RUN',side:'sell'},current,.03,'normal',2);
 html=chainPanel(d);
 assert.equal(html.includes('PREVIOUS-IN-CURRENT-RUN'),false);
 records.prepare({id:'CURRENT-SIGNAL',side:'buy'},current,.03,'normal',3);
 html=chainPanel(d);
 assert.ok(html.includes('CURRENT-SIGNAL'));
 assert.equal(html.includes('OLD-SIGNAL'),false);
 assert.equal(chainPanel({...d,session:null,signal:null}).includes('OLD-SIGNAL'),false);
 assert.equal(d.session,current);
 assert.equal(JSON.parse(before).session.id,d.session.id);
});

test('mobile market charts start with readable recent bars and keep explicit analysis windows',async()=>{
 const {initialChartRange}=await import('./product-chart-ui.mjs');
 const options={initialWindow:'all',mobileWindow:40};
 assert.deepEqual(initialChartRange(168,options,320),{start:128,count:40});
 assert.deepEqual(initialChartRange(168,options,1100),{start:0,count:168});
 assert.deepEqual(initialChartRange(168,{...options,initialRange:{start:20,count:16}},320),{start:20,count:16});
 assert.deepEqual(initialChartRange(168,{initialWindow:'all'},320),{start:0,count:168});
 assert.deepEqual(initialChartRange(24,options,320),{start:0,count:24});
 assert.deepEqual(initialChartRange(0,options,320),{start:0,count:0});
});

test('data search batches redraws and waits for IME composition without stealing focus', async()=>{
 const {bindSearchRender}=await import('./product-composition.mjs');
 const oldRAF=globalThis.requestAnimationFrame,oldDocument=globalThis.document;let queued=[],draws=0,values=[];
 try{
  globalThis.requestAnimationFrame=fn=>{queued.push(fn);return queued.length;};
  const listeners={},input={isConnected:true,value:'',selectionStart:0,selectionEnd:0,selectionDirection:'none',addEventListener:(name,fn)=>listeners[name]=fn};
  globalThis.document={activeElement:input};
  bindSearchRender(input,value=>values.push(value),()=>{draws++;return null;});
  listeners.compositionstart();input.value='宏';listeners.input({isComposing:true});assert.equal(queued.length,0);
  listeners.compositionend();input.value='宏观';listeners.input({isComposing:false});assert.equal(queued.length,1);queued.shift()();
  assert.deepEqual(values,['宏','宏','宏观']);assert.equal(draws,1);
  input.value='宏观事件';listeners.input({isComposing:false});input.isConnected=false;queued.shift()();assert.equal(draws,1);
 }finally{if(oldRAF===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=oldRAF;if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;}
});


test('chart ranges use actual timestamps, retain the full record count and never invent dates',async()=>{
 const {chartPresets,formatChartAxis,chartValueTicks}=await import('./product-chart-ui.mjs');
 const end=Date.UTC(2026,9,31),data=Array.from({length:240},(_,i)=>({time:end-(239-i)*3600000,value:i}));
 assert.deepEqual(chartPresets(data).map(p=>[p.label,p.count]),[['24H',24],['7D',168],['全部',240]]);
 assert.deepEqual(chartPresets(data.slice(0,5)),[]);
 assert.equal(chartPresets(Array.from({length:60},(_,i)=>({time:'T+'+i,value:i}))).at(-1).count,60);
 assert.equal(chartPresets(data.slice(0,30).reverse()).some(p=>p.label==='24H'),false);
 assert.equal(formatChartAxis(1250000000),'1.25B');
 assert.equal(formatChartAxis(.00000912),'0.00000912');
 assert.equal(formatChartAxis(0),'0');
 assert.deepEqual(chartValueTicks(97,113),[100,105,110]);
 assert.deepEqual(chartValueTicks(2,2),[]);
 assert.ok(chartValueTicks(-4,6).includes(0));
});

test('trade history separates strategy actions, trades and search without altering records',async()=>{
 const {tradeLogEntries}=await import('./product-views.mjs');
 const d={orders:[{id:'SIM-ORD-1',market:'ETH/USDT',strategy:'S03',runId:'SIM-1',side:'buy',at:10}],events:[{id:2,at:12,text:'策略已暂停。',market:'ETH/USDT',strategy:'S03'},{id:3,at:11,text:'SIM-ORD-1 已成交',kind:'fill'}]};
 const before=JSON.stringify(d);
 assert.deepEqual(tradeLogEntries({d}).map(x=>x.kind),['strategy','trade']);
 assert.equal(tradeLogEntries({d,filter:'交易记录'}).length,1);
 assert.equal(tradeLogEntries({d,filter:'策略操作'})[0].item.id,2);
 assert.equal(tradeLogEntries({d,query:'ETH'}).length,2);
 assert.equal(tradeLogEntries({d,query:'BTC'}).length,0);
 assert.equal(JSON.stringify(d),before);
});
test('an open choice picker prevents automatic repaint even when focus is on an option',async()=>{
 const {canAutoRefresh}=await import('./product-composition.mjs');
 const previous=globalThis.document;let open=true;
 const root={querySelector:selector=>open&&selector.includes('select:open')?{}:null,querySelectorAll:()=>[],contains:()=>false};
 try{
  globalThis.document={activeElement:{matches:()=>false},querySelector:()=>null};
  assert.equal(canAutoRefresh(root),false);open=false;assert.equal(canAutoRefresh(root),true);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
test('a closing portalled select holds repaint until its option releases focus',async()=>{
 const {canAutoRefresh}=await import('./product-composition.mjs');
 const previous=globalThis.document;let closing=true,focused=false;
 const root={querySelector:()=>null,querySelectorAll:()=>[],contains:()=>focused};
 try{
  globalThis.document={activeElement:{matches:()=>true},querySelector:selector=>selector==='.lq-select__listbox'||closing&&selector==='.lq-select__positioner:not([hidden]) .lq-select__listbox'?{}:null};
  assert.equal(canAutoRefresh(root),false,'closing popup outlives the host open flag');
  closing=false;focused=true;assert.equal(canAutoRefresh(root),false,'focus returns to the current trigger');
  focused=false;assert.equal(canAutoRefresh(root),true,'an autofill-mounted hidden popup cannot keep refresh locked');
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
test('expanded charts and other body dialogs keep the underlying page until they close',async()=>{
 const {canAutoRefresh}=await import('./product-composition.mjs');
 const previous=globalThis.document;let open=true;
 const root={querySelector:()=>null,querySelectorAll:()=>[],contains:()=>false};
 try{
  globalThis.document={activeElement:null,querySelector:selector=>selector==='dialog[open]'&&open?{open:true}:null};
  assert.equal(canAutoRefresh(root),false);
  open=false;assert.equal(canAutoRefresh(root),true);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('a visible official chart retains user studies until returning to the basic chart',async()=>{
 const {canAutoRefresh}=await import('./product-composition.mjs');
 const previous=globalThis.document;let view='widget';
 const root={querySelector:selector=>view==='widget'&&selector.includes('.trading-chart-hosted[data-chart-view=widget]')?{}:null,querySelectorAll:()=>[],contains:()=>false};
 try{
  globalThis.document={activeElement:null,querySelector:()=>null};
  assert.equal(canAutoRefresh(root),false);
  view='basic';assert.equal(canAutoRefresh(root),true);
  view=null;assert.equal(canAutoRefresh(root),true);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('automatic paint waits only for held controls and resumes after release or cancellation',async()=>{
 const {canAutoRefresh}=await import('./product-composition.mjs');
 const previous=globalThis.document;let pressed=null;
 const root={querySelector:selector=>pressed&&selector.includes(pressed+':active')?{}:null,querySelectorAll:()=>[],contains:()=>false};
 try{
  globalThis.document={activeElement:{matches:()=>false},querySelector:()=>null};
  assert.equal(canAutoRefresh(root),true);
  for(const [input,tag]of [['pointerdown','button'],['Space keydown','button'],['Enter activation','button'],['summary press','summary'],['navigation press','a']]){
   pressed=tag;assert.equal(canAutoRefresh(root),false,input);
   pressed=null;assert.equal(canAutoRefresh(root),true,input+' release');
  }
  pressed='button';assert.equal(canAutoRefresh(root),false);
  pressed=null;assert.equal(canAutoRefresh(root),true,'pointercancel leaves no lock');
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('an open compact account menu holds automatic repaint until it closes',async()=>{
 const {canAutoRefresh}=await import('./product-composition.mjs');
 const previous=globalThis.document;let open=true;
 const root={querySelector:selector=>open&&selector.includes('.account-navigation.is-open')?{}:null,querySelectorAll:()=>[],contains:()=>false};
 try{
  globalThis.document={activeElement:{matches:()=>false},querySelector:()=>null};
  assert.equal(canAutoRefresh(root),false);open=false;assert.equal(canAutoRefresh(root),true);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
