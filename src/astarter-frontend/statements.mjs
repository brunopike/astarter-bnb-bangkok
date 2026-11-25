import {statementRecords,projectStatements,statementScope,statementSearch,statementDay,statementMonth,statementCurveDay} from './statements-data.mjs?v=20261123p';
import {statementsView,statementOwnerName,statementHover} from './statements-view.mjs?v=20261123g';
import {L} from './execution-views.mjs';
import {STATEMENT_EXAMPLE,STATEMENT_MARKET_EXAMPLE,statementMarketExampleSnapshot,statementExampleSnapshot,statementExampleContext} from './trading-preview.mjs';

const walletAccountId=value=>{const id=typeof value==='string'?value.toLowerCase():'';return /^0x[0-9a-f]{40}$/.test(id)?id:'';};
function liveStatementAccount(snapshot,preferred=''){
 const accounts=snapshot?.connections?.tradingAccounts;
 if(!Array.isArray(accounts))return null;
 const walletRow=accounts.find(record=>record?.id==='wallet-bsc'&&record.status==='connected'&&walletAccountId(record.accountId));
 const wallet=walletRow?{accountId:walletAccountId(walletRow.accountId),environment:'LIVE',accountLabel:walletAccountId(walletRow.accountId).slice(0,6)+'…'+walletAccountId(walletRow.accountId).slice(-4)+' · BNB Chain'}:null;
 const book=snapshot.connections?.spotBook;
 const binance=accounts.some(record=>record?.id==='binance-spot'&&record.status==='connected')&&book?.symbol==='BTCUSDT'&&typeof book.usdt==='number'&&Number.isFinite(book.usdt)&&book.usdt>=0&&book.usdt<=1e15?{accountId:'BINANCE-SPOT',environment:'LIVE',accountLabel:L('PRO · 币安现货','PRO · Binance spot')}:null;
 if(preferred==='binance')return binance||wallet;
 if(preferred==='wallet')return wallet||binance;
 return wallet||binance;
}
export function createStatements({desk,root,dialog,show,navigate,notify=()=>{},storage=null}){
 let exampleId='',exampleData=null,accountKind='';
 let scope,records=null,model=null,modal=false,detailKey='',limit=20,month='',calendar=false,pageKey='',stamp='',returnSearch='',returnScroll=0,returnOrigin=null,returnEntry=null,returnTargetId='',returnPositions=[];
 const exampleActive=()=>[STATEMENT_EXAMPLE.id,STATEMENT_MARKET_EXAMPLE.id].includes(exampleId)&&statementExampleContext(desk.readSnapshot(),desk.syncStatus());
 const snapshot=()=>exampleId?(exampleActive()?(exampleData||=(exampleId===STATEMENT_MARKET_EXAMPLE.id?statementMarketExampleSnapshot():statementExampleSnapshot())):null):desk.readSnapshot();
 const status=()=>{const s=desk.syncStatus();if(exampleId)return exampleActive()?{...s,source:'EXAMPLE',scope:{accountId:'REVIEW-01',environment:'DEMO'}}:{...s,state:'UNAVAILABLE'};const live=liveStatementAccount(snapshot(),accountKind);return live?{...s,scope:{...(s.scope||{}),accountId:live.accountId,environment:live.environment},accountLabel:live.accountLabel}:s;};
 const search=(next,base)=>{const p=new URLSearchParams(statementSearch(next,base));if(exampleId)p.set('st_example',exampleId);else p.delete('st_example');return '?'+p;};
 const currentStamp=()=>{const d=snapshot(),s=status(),spot=[...(d?.connections?.spotBook?.orders||[]),...(d?.connections?.spotBook?.history||[])].map(order=>[order.orderId,order.status,order.executedQty]);return JSON.stringify([exampleId,s.scope?.accountId,s.scope?.environment,s.generation,s.state,d?.flow?.revision,d?.botBook?.flow?.revision,d?.botSummary?.revision,spot,[...(d?.positions||[]),...(d?.position?[d.position]:[]),...(d?.botBook?.runs||[])].map(p=>[p.id,p.qty,p.quantity,p.markPrice,p.margin,p.unrealizedPnl])]);};
 const savedOwner=()=>{try{return storage?.getItem('astarter.statements.owner')||'AI_SPECTRUM';}catch{return 'AI_SPECTRUM';}};
 const defaults=()=>({owner:savedOwner(),accountId:status().scope?.accountId,environment:status().scope?.environment,currency:''});
 function load(){const d=snapshot();records=d?statementRecords(d,status().scope):null;stamp=currentStamp();model=records?projectStatements(records,scope):null;}
 const detail=()=>detailKey?[...(records?.fills||[]),...(records?.orders||[]),...(records?.positions||[]),...(records?.events||[])].find(row=>row.key===detailKey):null;
 function markup(){return statementsView({records,model,scope,compact:modal,month,calendar,limit,exampleId,detail:detail(),status:status(),returnTo:Boolean(returnSearch),example:Boolean(exampleId)});}
 function draw(){
  const host=modal?dialog:root,rangeOpen=(!modal||dialog.open)&&host.querySelector?.('.st-range')?.open;
  const active=host.ownerDocument?.activeElement,attributes=['data-st-filter','data-st-day','data-st-action','data-st-owner','data-st-tab'];
  const focus=active?.closest?.('.statements')?attributes.filter(name=>active.hasAttribute(name)).map(name=>`[${name}="${CSS.escape(active.getAttribute(name))}"]`).join(''):'';
  if(modal){show(L('交易记录','Trade history')+' · '+statementOwnerName(scope.exceptions?null:scope.owner),markup(),restoreOrigin);dialog.classList.add('statements-dialog');}
  else {const host=root.querySelector('.statements');if(host)host.outerHTML=markup();}
  if(rangeOpen){const range=host.querySelector?.('.st-range');if(range)range.open=true;}
  if(focus){const host=modal?dialog:root;(host.querySelector(focus)||host.querySelector('.st-calendar button:not(:disabled)')||host.querySelector('.st-owner-tabs button'))?.focus({preventScroll:true});}
 }
 function update(patch){
  const active=(modal?dialog:root).ownerDocument.activeElement,filter=active?.dataset.stFilter;
  scope={...scope,...patch};
  if(records&&scope.currency!==''&&(patch.venueType!==undefined||patch.marketType!==undefined)){const currencies=[...new Set([...records.orders,...(records.positions||[])].filter(row=>row.owner===scope.owner&&(!scope.venueType||row.venueType===scope.venueType)&&(!scope.marketType||row.marketType===scope.marketType)).map(row=>row.currency))];if(currencies.length&&!currencies.includes(scope.currency))scope.currency=currencies[0];}
  limit=20;detailKey='';
  if(scope.from&&scope.to&&scope.from>scope.to){scope.to=scope.from;}
  if(records)model=projectStatements(records,scope);
  if(!modal){const nextSearch=search(scope,location.search);history.replaceState(null,'',nextSearch);pageKey=nextSearch;}
  draw();if(filter)(modal?dialog:root).querySelector(`[data-st-filter="${filter}"]`)?.focus({preventScroll:true});
 }
 function page(search=location.search){
  modal=false;const requested=new URLSearchParams(search).get('st_example');if(exampleId!==requested)exampleData=null;exampleId=requested===null?'':requested||'invalid';
  const key=search+'|'+status().scope?.accountId+'|'+status().scope?.environment;
  if(key!==pageKey){
   const params=new URLSearchParams(search),oldOrder=params.has('st_query')?null:params.get('order');
   scope=statementScope(search,defaults());if(oldOrder)scope.query=oldOrder;pageKey=key;limit=20;detailKey='';calendar=true;month=(scope.day||scope.to||statementDay(Date.now(),scope.timeZone)).slice(0,7);load();
   const targets=oldOrder?records?.orders.filter(row=>row.id===oldOrder)||[]:[];
   if(targets.length===1){
    const target=targets[0];
    if(!params.has('st_owner')&&!params.has('st_exceptions'))scope={...scope,owner:target.owner||scope.owner,exceptions:!target.owner};
    if(!params.has('st_currency'))scope.currency=target.currency;
    model=projectStatements(records,scope);
    if(model.orders.includes(target))detailKey=target.key;
   }
  }
  return markup();
 }
 function restoreOrigin(){
  if(returnTargetId){root.ownerDocument.getElementById(returnTargetId)?.focus({preventScroll:true});return;}
  const container=returnEntry?.containerId?root.ownerDocument.getElementById(returnEntry.containerId):root.ownerDocument;
  const entry=returnOrigin?.isConnected?returnOrigin:returnEntry?container?.querySelectorAll(returnEntry.selector)[returnEntry.index]:null;entry?.focus({preventScroll:true});
 }
 function open(options={},origin=document.activeElement){
  accountKind=options.accountKind||'';
  if(exampleId!==(options.example||''))exampleData=null;exampleId=options.example||'';returnSearch=location.search;returnScroll=root.scrollTop;returnOrigin=origin;returnEntry=null;returnTargetId=origin?.dataset?.statementReturnId||'';
  if(origin?.matches?.('[data-statements]')){
   const container=origin.parentElement?.closest('[id]'),selector=['data-statements','data-statement-run','data-statement-order'].filter(name=>origin.hasAttribute(name)).map(name=>`[${name}="${CSS.escape(origin.getAttribute(name))}"]`).join('');
   returnEntry={containerId:container?.id||'',selector,index:[...(container||root.ownerDocument).querySelectorAll(selector)].indexOf(origin)};
  }
  returnPositions=[...root.ownerDocument.querySelectorAll('.workspace,.workbench-terminal,.photonic-workbench,#product-page')].map(element=>({element,top:element.scrollTop,left:element.scrollLeft}));
  scope=statementScope('',{...defaults(),...options});try{if(!exampleId)storage?.setItem('astarter.statements.owner',scope.owner);}catch{}limit=20;detailKey='';calendar=false;modal=true;month=(scope.day||statementDay(Date.now(),scope.timeZone)).slice(0,7);load();if(records&&model&&scope.query&&scope.tab==='orders'&&model.openOrders.some(row=>row.id===scope.query)){scope.tab='openOrders';}draw();
 }
 function refresh(){load();draw();}
 const eventRoot=root.ownerDocument;
 eventRoot.addEventListener('click',async event=>{
  const entry=event.target.closest('[data-statements]');
  if(entry){
   event.preventDefault();const range={};
   for(const [field,key]of [['from','statementFrom'],['to','statementTo'],['day','statementDay'],['timeZone','statementZone'],['tab','statementTab']])if(entry.dataset[key]!==undefined)range[field]=entry.dataset[key];
   open({example:entry.dataset.statementExample||'',owner:entry.dataset.statements,runId:entry.dataset.statementRun||'',query:entry.dataset.statementOrder||'',accountKind:entry.dataset.statementAccount||'',...range},entry);return;
  }
  const target=event.target.closest('[data-st-action],[data-st-day],[data-st-detail]');
  if(!target||!target.closest('.statements'))return;
  event.preventDefault();
  if(target.dataset.stDay){update({day:scope.day===target.dataset.stDay?'':target.dataset.stDay});return;}
  if(target.dataset.stDetail){detailKey=target.dataset.stDetail;draw();(modal?dialog:root).querySelector('[data-st-action="back-detail"]')?.focus();return;}
  const action=target.dataset.stAction;
  if(action==='close-range'){const range=target.closest('.st-range');if(range){range.open=false;range.querySelector('summary')?.focus();}return;}
  if(action==='owner'){try{if(!exampleId)storage?.setItem('astarter.statements.owner',target.dataset.stOwner);}catch{}update({owner:target.dataset.stOwner,runId:'',symbol:'',day:'',exceptions:false});}
  if(action==='tab')update({tab:target.dataset.stTab});
  if(action==='calendar'){calendar=!calendar;draw();}
  if(action==='example-market'){exampleId=exampleId===STATEMENT_MARKET_EXAMPLE.id?STATEMENT_EXAMPLE.id:STATEMENT_MARKET_EXAMPLE.id;exampleData=null;scope={...scope,runId:'',query:'',symbol:'',venueType:'',marketType:'',currency:'',from:'',to:'',day:'',tab:'fills'};load();update({});}
  if(action==='clear-day')update({day:''});
  if(action==='range'&&[7,30,90].includes(Number(target.dataset.stDays))){const to=statementDay(exampleId?STATEMENT_EXAMPLE.asOf:Date.now(),scope.timeZone),from=new Date(Date.parse(to)-(Number(target.dataset.stDays)-1)*86400000).toISOString().slice(0,10);month=to.slice(0,7);update({from,to,day:''});}
  if(action==='clear-range')update({from:'',to:'',day:''});
  if(action==='exceptions')update({exceptions:!scope.exceptions,runId:'',symbol:'',query:''});
  if(action==='prev-month'||action==='next-month'){month=statementMonth(month,action==='prev-month'?-1:1);draw();}
  if(action==='more'){limit+=50;draw();}
  if(action==='detail'){detailKey=target.dataset.stKey;draw();(modal?dialog:root).querySelector('[data-st-action="back-detail"]')?.focus();}
  if(action==='back-detail'){const key=detailKey;detailKey='';draw();(modal?dialog:root).querySelector(`[data-st-detail="${CSS.escape(key)}"]`)?.focus();}
  if(action==='refresh'){if(!exampleId&&status().state!=='LIVE')desk.streamAction?.('retry');refresh();}
  if(action==='full'){modal=false;dialog.close();const nextSearch=search(scope,location.search);pageKey='';navigate('logs',{search:nextSearch});}
  if(action==='return'){
   const search=returnSearch;returnSearch='';navigate(new URLSearchParams(search).get('page')||'workbench',{search,restore:true});
   const restore=()=>{root.scrollTop=returnScroll;for(const {element,top,left}of returnPositions){if(element.isConnected){element.scrollTop=top;element.scrollLeft=left;}}restoreOrigin();};
   if(typeof requestAnimationFrame==='function')requestAnimationFrame(restore);else restore();
  }
  if(action==='run'&&!exampleId){dialog.close();navigate('execution',{runId:target.dataset.stRun});}
  if(action==='copy'){try{await navigator.clipboard.writeText((exampleId?L('参考数据 · 只读','Reference data · Read only')+' · ':'')+target.dataset.stCopy);notify(L('已复制','Copied'));}catch{notify(L('复制失败，请选择回执编号复制','Copy failed. Select the receipt ID to copy it'));}}
 });
 eventRoot.addEventListener('change',event=>{const field=event.target.closest('[data-st-filter]');if(field?.closest('.statements'))update({[field.dataset.stFilter]:field.value,day:''});});
 function inspectDay(plot,day){
  const value=statementCurveDay(model,scope,day);if(!value)return;if(plot.dataset.day===day&&!plot.querySelector('.st-curve-tooltip').hidden)return;
  const chart=plot.closest('[data-st-curve]'),span=Date.parse(chart.dataset.to)-Date.parse(chart.dataset.from),index=(Date.parse(day)-Date.parse(chart.dataset.from))/86400000;
  const x=span?1.82+index*86400000/span*96.36:50;
  plot.dataset.day=day;plot.setAttribute('aria-valuenow',String(index));plot.setAttribute('aria-valuetext',day+' '+L('当日净盈亏','Daily net PnL')+' '+value.net+' '+scope.currency);
  const tip=plot.querySelector('.st-curve-tooltip'),line=plot.querySelector('.st-crosshair');tip.innerHTML=statementHover(value,scope.currency);tip.hidden=false;line.hidden=false;line.style.left=x+'%';tip.style.left=Math.max(0,Math.min(plot.clientWidth-220,plot.clientWidth*x/100-110))+'px';
 }
 const inspectPointer=event=>{const plot=event.target.closest?.('.st-curve-plot');if(!plot||!model)return;const chart=plot.closest('[data-st-curve]'),box=plot.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,((event.clientX-box.left)/box.width-.0182)/.9636)),days=Math.round((Date.parse(chart.dataset.to)-Date.parse(chart.dataset.from))/86400000);inspectDay(plot,new Date(Date.parse(chart.dataset.from)+Math.round(ratio*days)*86400000).toISOString().slice(0,10));};
 eventRoot.addEventListener('pointermove',inspectPointer);eventRoot.addEventListener('pointerdown',inspectPointer);
 eventRoot.addEventListener('pointerout',event=>{const plot=event.target.closest?.('.st-curve-plot');if(plot&&!plot.contains(event.relatedTarget)){plot.querySelector('.st-curve-tooltip').hidden=true;plot.querySelector('.st-crosshair').hidden=true;}});
 eventRoot.addEventListener('focusin',event=>{const plot=event.target.closest?.('.st-curve-plot');if(plot&&model)inspectDay(plot,plot.dataset.day||plot.closest('[data-st-curve]').dataset.from);});
 eventRoot.addEventListener('keydown',event=>{const plot=event.target.closest?.('.st-curve-plot');if(!plot)return;if(event.key==='Escape'){plot.querySelector('.st-curve-tooltip').hidden=true;plot.querySelector('.st-crosshair').hidden=true;return;}if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const chart=plot.closest('[data-st-curve]'),from=Date.parse(chart.dataset.from),to=Date.parse(chart.dataset.to),at=Date.parse(plot.dataset.day||chart.dataset.from);inspectDay(plot,new Date(event.key==='Home'?from:event.key==='End'?to:Math.max(from,Math.min(to,at+(event.key==='ArrowRight'?1:-1)*86400000))).toISOString().slice(0,10));});
 dialog.addEventListener('close',()=>{if(dialog.open)return;dialog.classList.remove('statements-dialog');modal=false;});
 function tick(){
  if(!scope||!(modal&&dialog.open||document.body.dataset.page==='logs'))return;
  if(status().scope?.accountId!==scope.accountId||status().scope?.environment!==scope.environment){scope=statementScope('',{...defaults(),owner:scope.owner,timeZone:scope.timeZone,tab:scope.tab,from:scope.from,to:scope.to});detailKey='';load();draw();return;}
  if(stamp===currentStamp())return;
  const host=(modal?dialog:root).querySelector('.statements');if(!host||host.querySelector('.st-new-records'))return;
  const note=document.createElement('button');note.type='button';note.className='st-button st-new-records';note.dataset.stAction='refresh';note.textContent=L('记录已更新 · 刷新','Records updated · Refresh');note.setAttribute('role','status');host.prepend(note);
 }
 return {page,open,tick};
}
