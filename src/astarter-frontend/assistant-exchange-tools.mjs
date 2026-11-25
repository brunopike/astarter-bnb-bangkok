import {L} from './execution-views.mjs';
import {uiGlyph} from './product-composition.mjs';
import {venueIcon} from './brand-icons.mjs';
import {EXCHANGE_ASSETS,EXCHANGE_PERIODS,EXCHANGE_OPERATIONS,PRIVATE_EXCHANGE_OPERATIONS,EXCHANGE_CAPABILITIES} from './assistant-exchange-data.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels=EXCHANGE_CAPABILITIES;
const name=p=>p==='okx'?'OKX':'Binance';
const scope=(provider,operation)=>operation==='account'?provider==='binance'?L('现货账户资产','Spot account balances'):L('交易账户资产','Trading account balances'):operation==='positions'&&provider==='binance'?L('USDⓈ-M 合约持仓','USDⓈ-M positions'):L(...labels[operation]);
const number=(v,digits=10)=>v==null?'—':Number(v)!==0&&Math.abs(Number(v))<10**-digits?Number(v).toExponential(4).replace(/\.?0+e/,'e'):Number(v).toLocaleString('en-US',{maximumFractionDigits:digits});
const time=v=>Number.isFinite(v)?new Date(v+28800000).toISOString().slice(0,19).replace('T',' ')+' UTC+8':'—';
const errors={AUTH_REQUIRED:['请先连接这个交易所的只读账户','Connect this exchange account first'],AUTH_OR_PERMISSION:['密钥、IP 白名单或读取权限未通过，请核对后重试','Check your key, IP allowlist and read permissions, then retry'],READ_ONLY_KEY_REQUIRED:['请使用仅开启读取权限的 API Key','Use an API key with read permission only'],INVALID_CREDENTIALS:['请填写完整、有效的 API 凭据','Enter valid API credentials'],UPSTREAM_TIMEOUT:['交易所响应超时，请重试','The exchange timed out. Try again'],UPSTREAM_UNAVAILABLE:['暂时无法连接交易所，请重试','The exchange is unavailable. Try again'],RATE_LIMITED:['请求过于频繁，请稍后重试','Too many requests. Try again shortly'],INVALID_RESPONSE:['交易所返回的数据不完整，请重试','The exchange returned incomplete data. Try again'],INSUFFICIENT_CANDLES:['已收盘 K 线不足，暂不能计算','Not enough closed candles for analysis'],CONNECTION_CHANGED:['账户连接已变化，请重新查询','The account connection changed. Run the query again']};
errors.SERVICE_UNAVAILABLE=['交易所工具服务暂不可用，请稍后重试','Exchange tools are unavailable. Try again shortly'];
errors.CONNECTION_EXPIRED=['只读连接已过期，请重新连接','The read-only connection expired. Reconnect to continue'];
errors.INSTRUMENT_UNAVAILABLE=['该站点没有这个交易对，请选择其他标的','This instrument is unavailable on this site. Choose another asset'];
const message=code=>L(...(errors[code]||errors.UPSTREAM_UNAVAILABLE));
const td=value=>`<td>${esc(value)}</td>`;
function table(columns,rows){return `<div class="exchange-table-wrap" tabindex="0" role="region" aria-label="${L('查询结果，可横向滚动','Query results, horizontally scrollable')}"><table><thead><tr>${columns.map(c=>`<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(td).join('')}</tr>`).join('')}</tbody></table></div>`;}
export function exchangeResultHTML(result){
 const {operation,rows,asset,unit}=result;
 const metric=(label,value,exact='')=>`<div><dt>${esc(label)}</dt><dd${exact?` title="${esc(exact)}"`:''}>${esc(value)}</dd></div>`;
 if(!rows.length)return `<p class="exchange-empty">${L('当前查询没有记录','No records for this query')}</p>`;
 if(operation==='market'){
  const r=rows[0];return `<dl class="exchange-metrics">${metric(L('最新价格','Last price'),number(r.last)+' '+unit)}${metric(L('24h 涨跌','24h change'),r.changePct==null?'—':(r.changePct>=0?'+':'')+number(r.changePct)+'%')}${metric(L('24h 最高','24h high'),number(r.high)+' '+unit)}${metric(L('24h 最低','24h low'),number(r.low)+' '+unit)}${metric(L('24h 成交量','24h base volume'),number(r.volume,6)+' '+asset,r.volume==null?'':r.volume+' '+asset)}${metric(L('24h 成交额','24h turnover'),number(r.quoteVolume,2)+' '+unit,r.quoteVolume==null?'':r.quoteVolume+' '+unit)}</dl>`;
 }
 if(operation==='orderbook')return table([L('方向','Side'),L('价格','Price')+' · '+unit,L('数量','Quantity')+' · '+asset],rows.map(r=>[r.side==='buy'?L('买盘','Buy side'):L('卖盘','Sell side'),number(r.price),number(r.quantity)]));
 if(operation==='candles')return table([L('开盘时间','Open time'),L('开','Open'),L('高','High'),L('低','Low'),L('收','Close'),L('成交量','Volume')+' · '+asset],[...rows].reverse().map(r=>[time(r.time),...['open','high','low','close','volume'].map(k=>number(r[k]))]));
 if(operation==='funding'){
  const r=rows[0];return `<dl class="exchange-metrics">${metric(L('永续合约','Perpetual'),r.market)}${metric(L('资金费率','Funding rate'),number(r.ratePct)+'%')}${metric(L('下一结算时间','Next funding'),time(r.nextTime))}${metric(L('标记价格','Mark price'),r.markPrice==null?'—':number(r.markPrice)+' '+unit)}</dl>`;
 }
 if(operation==='analysis'){
  const a=result.analysis;return `<p>${L('按已收盘 K 线计算，原始数据和时间窗口保持可查。','Calculated from closed candles, with the source window available below.')}</p><dl class="exchange-metrics">${metric(L('窗口收盘价','Window close'),number(a.last)+' '+unit)}${metric('MA 5 / MA 20',number(a.ma5)+' / '+number(a.ma20))}${metric('ATR 14',number(a.atr14)+' '+unit)}${metric(L('近 20 根最高 / 最低','20-bar high / low'),number(a.rangeHigh)+' / '+number(a.rangeLow))}</dl><p>${esc(time(a.start))} → ${esc(time(a.end))} · ${a.count} ${L('根已收盘 K 线','closed candles')}</p><button type="button" class="p-button" data-exchange-candles>${L('查看计算数据','View calculation data')}${uiGlyph('arrow')}</button>`;
 }
 if(operation==='account')return table([L('资产','Asset'),L('可用','Available'),L('冻结','Held'),L('总量','Total balance')],rows.map(r=>[r.asset,number(r.available),number(r.held),number(r.total)]));
 if(operation==='positions')return table([L('合约','Contract'),L('方向','Side'),L('持仓量','Size'),L('开仓价','Entry'),L('标记价格','Mark'),L('未实现盈亏','Unrealized P&L')],rows.map(r=>{
  const raw=r.side.toLowerCase(),side=['both','net'].includes(raw)?r.size<0?'short':'long':raw;
  return [r.market,side==='long'?L('多头','Long'):side==='short'?L('空头','Short'):r.side,number(r.size)+' '+(r.sizeUnit==='contracts'?L('张','contracts'):r.sizeUnit),number(r.entry),number(r.mark),number(r.pnl)+' '+r.unit];
 }));
 return table([L('成交时间','Fill time'),L('交易对','Trading pair'),L('方向','Side'),L('价格','Price'),L('数量','Quantity'),L('费用','Trading fee')],rows.map(r=>[time(r.time),r.market,r.side==='buy'?L('买入','Buy'):L('卖出','Sell'),number(r.price),number(r.quantity),number(r.fee)+' '+r.feeAsset]));
}
export function createAssistantExchangeTools({onSource,fetchImpl=(...args)=>fetch(...args)}){
 let dialog=null,provider='binance',operation='market',connection=null,controller=null,generation=0,lastResult=null,serviceAvailable=null,expiryTimer=0;
 function dispose(){generation++;controller?.abort();clearTimeout(expiryTimer);expiryTimer=0;controller=null;lastResult=null;dialog?.querySelector('[data-exchange-connect]')?.reset();dialog?.querySelector('[data-exchange-output]')?.replaceChildren();dialog=null;}
 async function request(path,options={}){
  const response=await fetchImpl('/api/assistant/exchanges/'+provider+'/'+path,{...options,credentials:'same-origin',signal:controller?.signal,headers:{'X-Astarter-Exchange':'1',...(connection?.connectionId?{'X-Astarter-Connection':connection.connectionId}:{}),...options.headers}});
  let value;try{value=await response.json();}catch{throw Error('SERVICE_UNAVAILABLE');}
  if(!response.ok)throw Error(value.error||'SERVICE_UNAVAILABLE');if(value.provider!==provider)throw Error('INVALID_RESPONSE');return value;
 }
 function paintConnection(){
  if(!dialog?.open)return;clearTimeout(expiryTimer);const connected=!!connection?.connected;
  dialog.querySelector('[data-exchange-status]').textContent=serviceAvailable===false?message('SERVICE_UNAVAILABLE'):connected?L('账户已连接 · 只读权限已验证','Connected · Read permissions verified'):PRIVATE_EXCHANGE_OPERATIONS.includes(operation)?L('账户未连接 · 连接后读取','Account disconnected · Connect to read'):L('公开行情查询 · 账户未连接','Public markets · Account disconnected');
  const disconnect=dialog.querySelector('[data-exchange-disconnect]');disconnect.hidden=!connected;
  dialog.querySelector('[data-exchange-query-form]').hidden=PRIVATE_EXCHANGE_OPERATIONS.includes(operation)&&!connected;
  dialog.querySelector('[data-exchange-expiry]').textContent=connected?L('本地连接有效至 ','Local connection expires at ')+time(connection.expiresAt):'';
  if(connected&&Number.isFinite(connection.expiresAt))expiryTimer=setTimeout(()=>{
   if(!dialog?.open)return;connection={...connection,connected:false,connectionId:null};paintConnection();
   if(PRIVATE_EXCHANGE_OPERATIONS.includes(operation)){generation++;controller?.abort();lastResult=null;dialog.querySelector('[data-exchange-output]').innerHTML=`<p role="status">${esc(message('CONNECTION_EXPIRED'))}</p>`;dialog.querySelector('[data-exchange-query]').setAttribute('aria-disabled','false');dialog.querySelector('[data-exchange-credentials]').open=true;}
  },Math.max(0,connection.expiresAt-Date.now()));
 }
 async function status(ticket){try{const value=await request('status');if(ticket===generation&&dialog?.open){connection=value;serviceAvailable=true;paintConnection();}}catch{if(ticket===generation){connection=null;serviceAvailable=false;paintConnection();}}}
 function selectedOperation(next){
  if(!EXCHANGE_OPERATIONS.includes(next))return;operation=next;dialog.querySelector('[data-exchange-title]').textContent=name(provider)+' · '+L(...labels[operation]);controller?.abort();controller=new AbortController();generation++;lastResult=null;
  for(const b of dialog.querySelectorAll('[data-exchange-operation]'))b.setAttribute('aria-pressed',String(b.dataset.exchangeOperation===operation));
  dialog.querySelector('[data-exchange-period-wrap]').hidden=!['candles','analysis'].includes(operation);
  dialog.querySelector('[data-exchange-asset-wrap]').hidden=['account','positions'].includes(operation);
  query();
 }
 async function query(){
  const ticket=++generation;controller?.abort();controller=new AbortController();lastResult=null;
  const output=dialog.querySelector('[data-exchange-output]'),button=dialog.querySelector('[data-exchange-query]');
  output.innerHTML=`<p role="status">${L('正在查询…','Fetching data…')}</p>`;button.setAttribute('aria-disabled','true');output.setAttribute('aria-busy','true');
  try{
   if(serviceAvailable===false)throw Error('SERVICE_UNAVAILABLE');
   if(PRIVATE_EXCHANGE_OPERATIONS.includes(operation)&&!connection?.connected){
    output.innerHTML=`<p>${L('连接这个交易所的只读账户后，继续本次查询。','Connect this exchange account with read-only permissions to continue this query.')}</p>`;dialog.querySelector('[data-exchange-credentials]').open=true;dialog.querySelector('[name=apiKey]').focus({preventScroll:true});return;
   }
   const asset=dialog.querySelector('[data-exchange-asset]').value,period=dialog.querySelector('[data-exchange-period]').value;
   const value=await request(operation+'?'+new URLSearchParams({asset,period,site:connection?.site||'global'}));
   if(ticket!==generation||!dialog?.open)return;
   if(value.provider!==provider||value.operation!==operation||value.asset!==asset||value.period!==period||!Array.isArray(value.rows)||!Number.isFinite(value.asOf)||value.private!==PRIVATE_EXCHANGE_OPERATIONS.includes(operation)||value.private&&value.connectionId!==connection?.connectionId)throw Error('INVALID_RESPONSE');
   serviceAvailable=true;paintConnection();lastResult=value;const subject=['account','positions'].includes(operation)?scope(provider,operation):value.market;output.innerHTML=`<div class="exchange-result-heading"><h3>${name(provider)} · ${esc(subject)}</h3><time>${esc(time(value.asOf))}</time></div>${value.private?`<p class="exchange-private-scope">${L('当前账户 · 本次已读取','Your account · Retrieved')} ${value.rows.length} ${L('条记录；仅在此窗口显示','records; shown only in this window')}</p>`:''}${exchangeResultHTML(value)}${value.private?'':`<button type="button" class="p-button" data-exchange-source>${L('带入对话分析','Use in conversation')}${uiGlyph('arrow')}</button>`}`;
   output.querySelector('[data-exchange-candles]')?.addEventListener('click',()=>selectedOperation('candles'));
   output.querySelector('[data-exchange-source]')?.addEventListener('click',()=>{if(!lastResult||lastResult.private)return;const snapshot={...value,rows:value.rows.slice(-24),totalRows:value.rows.length,includedRows:Math.min(24,value.rows.length)},source={id:`exchange:${provider}:${operation}:${asset}:${value.asOf}`,title:name(provider)+' · '+value.market+' · '+L(...labels[operation]),kind:'market',href:'',text:time(value.asOf)+'\n'+JSON.stringify(snapshot)},current=dialog;if(onSource(source)!==false)current.close();});
  }catch(error){
   if(ticket!==generation||!dialog?.open||error.name==='AbortError')return;
   output.innerHTML=`<p role="alert">${esc(message(error.message))}</p><button type="button" class="p-button" data-exchange-retry>${L('重试','Retry')}</button>`;
   output.querySelector('[data-exchange-retry]').onclick=query;
   if(['AUTH_REQUIRED','AUTH_OR_PERMISSION','CONNECTION_CHANGED'].includes(error.message)){await status(ticket);if(ticket===generation){dialog.querySelector('[data-exchange-credentials]').open=true;dialog.querySelector('[name=apiKey]').focus({preventScroll:true});}}
  }finally{if(ticket===generation&&dialog?.open){button.setAttribute('aria-disabled','false');output.setAttribute('aria-busy','false');}}
 }
 function open(target,selectedProvider,initial='market',selection={}){
  dispose();dialog=target;provider=selectedProvider;operation=({trades:'fills',plan:'analysis'})[initial]||initial;if(!EXCHANGE_OPERATIONS.includes(operation))operation='market';connection=null;serviceAvailable=null;controller=new AbortController();const ticket=++generation;
  dialog.innerHTML=`<header class="p-dialog-head"><h2 id="chat-provider-title">${venueIcon(provider,{size:24})}<span data-exchange-title data-no-translate>${name(provider)} · ${L(...labels[operation])}</span></h2><div><button type="button" class="p-dialog-close" data-exchange-close aria-label="${L('关闭工具','Close tools')}">${uiGlyph('close')}</button></div></header><div class="p-dialog-body exchange-tools"><section class="exchange-connection"><div><strong data-exchange-status>${L('正在检查连接…','Checking connection…')}</strong><small data-exchange-expiry></small></div><button type="button" class="p-button" data-exchange-disconnect hidden>${L('断开账户','Disconnect account')}</button></section><details class="exchange-credentials" data-exchange-credentials ${PRIVATE_EXCHANGE_OPERATIONS.includes(operation)?'':'hidden'}><summary>${L('连接只读账户','Connect a read-only account')}</summary><form data-exchange-connect autocomplete="off"><p>${L('使用仅开启读取权限的 API Key。凭据仅在本机内存保留 30 分钟，断开即清除。','Use a read-only API key. Credentials stay in local memory for 30 minutes and are cleared on disconnect.')}</p>${provider==='okx'?`<label>${L('账户站点','Account site')}<select name="site"><option value="global">Global</option><option value="eea">EEA</option><option value="us">US</option><option value="tr">TR</option></select></label>`:''}${[['apiKey','API Key'],['secretKey','Secret Key'],...(provider==='okx'?[['passphrase','Passphrase']]:[])].map(([id,label])=>`<label>${label}<input type="password" name="${id}" required minlength="8" maxlength="256" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"></label>`).join('')}<div class="exchange-connect-actions"><button class="p-button p-primary" type="submit">${L('验证并连接','Verify and connect')}</button><a href="${provider==='okx'?'https://www.okx.com/account/my-api':'https://www.binance.com/en/my/settings/api-management'}" target="_blank" rel="noopener noreferrer">${L('管理 API Key','Manage API keys')} ↗</a></div><p data-exchange-connect-message role="status" tabindex="-1"></p></form></details><form class="exchange-query" data-exchange-query-form><label data-exchange-asset-wrap ${['account','positions'].includes(operation)?'hidden':''}>${L('交易标的','Asset')}<select data-exchange-asset>${EXCHANGE_ASSETS.map(id=>`<option>${id}</option>`).join('')}</select></label><label data-exchange-period-wrap ${!['candles','analysis'].includes(operation)?'hidden':''}>${L('周期','Interval')}<select data-exchange-period>${EXCHANGE_PERIODS.map(id=>`<option ${id==='1H'?'selected':''}>${id}</option>`).join('')}</select></label><button type="submit" class="p-button p-primary" data-exchange-query>${L('查询','Query')}${uiGlyph('refresh')}</button></form><section data-exchange-output aria-live="polite" aria-busy="false"></section></div>`;
  dialog.querySelector('[data-exchange-close]').onclick=()=>dialog.close();
  dialog.querySelector('[data-exchange-asset]').value=EXCHANGE_ASSETS.includes(selection.asset)?selection.asset:'BTC';dialog.querySelector('[data-exchange-period]').value=EXCHANGE_PERIODS.includes(selection.period)?selection.period:'1H';
  dialog.querySelector('[data-exchange-query-form]').onsubmit=e=>{e.preventDefault();if(dialog.querySelector('[data-exchange-query]').getAttribute('aria-disabled')!=='true')query();};
  for(const control of dialog.querySelectorAll('[data-exchange-asset],[data-exchange-period]'))control.onchange=()=>{controller?.abort();generation++;lastResult=null;query();};
  dialog.querySelector('[data-exchange-connect]').onsubmit=async event=>{
   event.preventDefault();const form=event.currentTarget,submit=form.querySelector('button[type="submit"]');if(submit.getAttribute('aria-disabled')==='true')return;const values=Object.fromEntries(new FormData(form));form.reset();
   const ticket=++generation;controller?.abort();controller=new AbortController();lastResult=null;dialog.querySelector('[data-exchange-output]').replaceChildren();dialog.querySelector('[data-exchange-output]').setAttribute('aria-busy','false');dialog.querySelector('[data-exchange-query]').setAttribute('aria-disabled','false');const feedback=form.querySelector('[data-exchange-connect-message]');submit.setAttribute('aria-disabled','true');feedback.setAttribute('role','status');feedback.textContent=L('正在验证读取权限…','Verifying read permissions…');
   try{const value=await request('connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});if(ticket!==generation||!dialog?.open)return;connection=value;paintConnection();feedback.textContent=L('已连接','Connected');dialog.querySelector('[data-exchange-credentials]').open=false;dialog.querySelector('[data-exchange-query]').focus({preventScroll:true});query();}
   catch(error){if(ticket===generation&&error.name!=='AbortError'){feedback.setAttribute('role','alert');feedback.textContent=message(error.message);await status(ticket);if(ticket===generation&&dialog?.open)feedback.focus({preventScroll:true});}}
   finally{for(const key of Object.keys(values))values[key]='';if(dialog?.open)submit.setAttribute('aria-disabled','false');}
  };
  dialog.querySelector('[data-exchange-disconnect]').onclick=async()=>{
   const ticket=++generation;controller?.abort();controller=new AbortController();lastResult=null;dialog.querySelector('[data-exchange-output]').replaceChildren();
   try{const value=await request('connection',{method:'DELETE'});if(ticket===generation){connection=value;paintConnection();dialog.querySelector('[data-exchange-credentials]').open=true;dialog.querySelector('[name=apiKey]').focus({preventScroll:true});}}
   catch(error){if(ticket===generation)dialog.querySelector('[data-exchange-output]').textContent=message(error.message);}
  };
  dialog.querySelector('[data-exchange-close]').focus({preventScroll:true});
  status(ticket).then(()=>{if(ticket===generation&&dialog?.open)query();});
 }
 return {open,dispose};
}
