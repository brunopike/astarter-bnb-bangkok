import {TOKEN_IDS} from './brand-icon-data.mjs';
import {MARKET,SNAPSHOT} from './data-center-fixtures.mjs';
import {fetchWatchAssets} from './market-watchlist.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {chartPanel} from './product-chart-ui.mjs';
import {escapeUI as esc} from './product-experience.mjs';
import {L} from './execution-views.mjs';

const tradfi=['SPX','NDX','XAU','DXY','US10Y'];
const number=v=>Number.isFinite(v)?v.toLocaleString('en-US',{maximumFractionDigits:Math.abs(v)<1?7:2}):'—';
const stamp=at=>Number.isFinite(at)?new Date(at).toLocaleString('en-GB',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})+' UTC+8':'—';

export function relatedAssetTarget(href){
 if(typeof href!=='string'||!href.startsWith('?'))return null;
 const p=new URLSearchParams(href);
 if(p.get('page')!=='markets')return null;
 if(p.has('data')&&p.get('data')!=='demo')return null;
 const symbol=(p.get('asset')||'').toUpperCase(),coin=p.get('coin');
 if(!/^[A-Z0-9]{1,15}$/.test(symbol))return null;
 const matches=Object.keys(TOKEN_IDS).filter(id=>TOKEN_IDS[id]===symbol);
 const id=coin?TOKEN_IDS[coin]===symbol?coin:null:matches.length===1?matches[0]:null;
 if(!id&&!tradfi.includes(symbol))return null;
 return {symbol,id,example:p.get('data')==='demo'||tradfi.includes(symbol),href};
}

export async function readRelatedAsset(target,{rows=[],quote=a=>({...a,quote:'USD',provider:'CoinGecko'}),load=fetchWatchAssets,signal,now=Date.now()}={}){
 if(target.example){
  const a=MARKET.find(a=>a.symbol===target.symbol);
  if(!a)return {state:'unavailable'};
  return {state:'example',asset:a,quote:{price:a.price,change:a.change,quote:L(a.unit||'USD',({'点':'pts','USD/盎司':'USD/oz'})[a.unit]||a.unit||'USD'),provider:L('本地样本','Local sample'),asOf:Date.parse(SNAPSHOT.replace(' ','T')+':00+08:00')}};
 }
 let asset=rows.find(a=>a.id===target.id),error=false;
 if(!asset||!Number.isFinite(asset.asOf)||now-asset.asOf>300000){
  try{
   const result=await load([{id:target.id,symbol:target.symbol,name:target.symbol,series:[]}],{signal});
   if(result.failed||result.rows?.[0]?.id!==target.id||!Number.isFinite(result.rows[0].price))error=true;
   else asset=result.rows[0];
  }catch(issue){if(signal?.aborted)throw issue;error=true;}
 }
 if(!asset||!Number.isFinite(asset.price))return {state:'unavailable'};
 const q=quote(asset);
 return {asset,quote:q,state:error||!Number.isFinite(q.asOf)||now-q.asOf>300000?'stale':'ready'};
}

export function relatedAssetView(target,result){
 if(result.state==='unavailable')return `<div class="related-empty" role="status"><strong>${L('暂时没有可用行情','Market data is unavailable')}</strong><p>${L('可以重试，或打开数据中心查看来源状态。','Retry, or open the data center to check the source.')}</p><button type="button" class="p-button" data-related-retry>${L('重试','Retry')}</button></div>`;
 const {asset:a,quote:q,state}=result,series=(a.series||[]).filter(Number.isFinite),validSeries=series.length>1&&Number.isFinite(a.asOf),tone=q.change>0?'up':q.change<0?'down':'flat';
 const change=Number.isFinite(q.change)?q.change.toLocaleString('en-US',{maximumFractionDigits:2,signDisplay:'exceptZero'})+'%':'—';
 // The fixed TradFi sample uses zero as a missing-volume placeholder.
 const volume=state==='example'?(a.domain==='TradFi'?null:a.volume*1e6):q.volume;
 return `<div class="related-quote"><div class="related-identity">${tokenIcon(target.symbol,{size:32})}<div><b>${esc(target.symbol)}</b><span>${esc(a.name)}</span></div></div><div class="related-price"><strong>${number(q.price)}</strong><span>${esc(q.quote)}</span><b class="dc-${tone}">${change}</b></div></div><p class="related-source">${esc(q.provider)} · ${esc(stamp(q.asOf))}${state==='example'?` · ${L('固定样本','Fixed sample')}`:state==='stale'?` · ${L('上次数据，更新失败或已过期','Last data; update failed or stale')}`:''}</p>${validSeries?chartPanel('related-asset',{title:target.symbol+' · '+L('历史价格','Price history'),values:series,labels:series.map((_,i)=>a.asOf-(series.length-1-i)*3600000),unit:'USD',height:190,compact:true,initialWindow:'all',showPresets:false}):`<div class="related-empty related-no-chart">${L('当前来源未提供历史曲线','No price history from this source')}</div>`}<dl class="related-stats"><div><dt>${L('24h 成交额','24h volume')}</dt><dd>${Number.isFinite(volume)&&volume>=0?number(volume)+' '+(state==='example'?'USD':esc(q.quote)):'—'}</dd></div><div><dt>${L('24h 变化','24h change')}</dt><dd class="dc-${tone}">${change}</dd></div></dl>`;
}
