import {createMarketHubClient,HUB_RESOURCES} from './market-hub-data.mjs';
import {L} from './execution-views.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {escapeUI as esc} from './product-experience.mjs';
import {PAGES} from './product-data.mjs';

const productPages=new Set(PAGES.map(([id])=>id));
const sourceTime=at=>new Date(at).toISOString().slice(0,19).replace('T',' ')+' UTC';

// Reuse the data centre’s validated 24-hour quotes without loading its other resources.
export function createConnectionTicker(bar,{fetchImpl=globalThis.fetch,now=Date.now}={}){
 const viewport=bar.querySelector('.connection-ticker'),source=bar.querySelector('.connection-ticker-source');
 let stamp='',disposed=false,suspended=false;
 const visible=()=>!disposed&&!suspended&&!document.hidden&&productPages.has(document.body.dataset.page);
 const client=createMarketHubClient({fetchImpl,now,onChange:paint,resources:['tickers'],WebSocketImpl:null,refreshSeconds:30,shareTickersWhen:visible});
 function paint(){
  const state=client.read('tickers'),rows=state.snapshot?.data||[];
  const delayed=rows.filter(row=>state.error||globalThis.navigator?.onLine===false||now()-row.asOf>HUB_RESOURCES.tickers.stale);
  const stale=new Set(delayed.map(row=>row.symbol));
  const label=rows.length?stale.size===rows.length?L('延迟','Delayed'):'Binance':L('行情','Markets');
  source.querySelector('b').textContent=label;
  source.title=rows.length?rows.map(row=>row.symbol+' · '+row.provider+' · '+sourceTime(row.asOf)).join('\n'):L('公开只读行情，与交易执行独立','Public read-only prices, separate from execution');
  viewport.setAttribute('aria-label',L('24 小时涨跌；悬停或聚焦可暂停滚动','24h change; hover or focus to pause'));
  const waitingToRetry=!rows.length&&state.retryIn>0;
  const key=JSON.stringify([rows,label,...stale,state.pending&&!rows.length,state.error,waitingToRetry,Math.ceil(globalThis.innerWidth/420)]);
  if(key===stamp)return;stamp=key;
  if(!rows.length){
   const retry=waitingToRetry?L('将自动重试','Retrying shortly.'):`<button type="button" data-ticker-retry>${L('重试','Retry')}</button>`;
   viewport.innerHTML=`<div class="connection-ticker-empty" role="status">${state.pending?L('正在获取行情…','Loading quotes…'):`<span>${L('行情暂不可用','Quotes unavailable')}</span>${retry}`}</div>`;
   return;
  }
  const copies=Math.max(1,Math.ceil((globalThis.innerWidth||1440)/(rows.length*130)));
  const quotes=Array.from({length:copies},()=>rows.map(row=>`<span data-ticker-symbol="${esc(row.symbol)}" title="${esc(row.provider)} · ${sourceTime(row.asOf)}">${tokenIcon(row.symbol,{size:14})}<b>${esc(row.symbol)}/USDT</b><em data-up="${Number.isFinite(row.change)?String(row.change>=0):'unknown'}">${Number.isFinite(row.change)?(row.change>0?'+':'')+row.change.toFixed(2)+'%':'—'}</em><span>${row.price.toLocaleString('en-US',{maximumFractionDigits:row.price<1?8:2,minimumFractionDigits:2})}</span>${stale.has(row.symbol)?`<small class="ticker-delayed">${L('延迟','Delayed')} · ${sourceTime(row.asOf)}</small>`:''}</span>`).join('')).join('');
  const phase=viewport.querySelector?.('.connection-ticker-track')?.getAnimations?.()[0]?.currentTime;
  viewport.innerHTML=`<div class="connection-ticker-track">${[false,true].map(copy=>`<div class="connection-quotes" ${copy?'aria-hidden="true"':''}>${quotes}</div>`).join('')}</div>`;
  const animation=viewport.querySelector?.('.connection-ticker-track')?.getAnimations?.()[0];if(animation&&Number.isFinite(phase))animation.currentTime=phase;
 }
 function refresh(){
  if(disposed)return;
  const active=visible();bar.dataset.tickerActive=String(active);
  client.setActive(active);if(active){client.tick();paint();}
 }
 const retry=event=>{if(event.target.closest('[data-ticker-retry]'))void client.refresh();};
 viewport.addEventListener('click',retry);
 const routes=typeof MutationObserver==='function'?new MutationObserver(refresh):null;
 routes?.observe(document.body,{attributes:true,attributeFilter:['data-page']});
 return {refresh,resume(){suspended=false;refresh();},pause(){suspended=true;client.setActive(false);bar.dataset.tickerActive='false';},
  dispose(){disposed=true;routes?.disconnect();viewport.removeEventListener?.('click',retry);client.dispose();}};
}
