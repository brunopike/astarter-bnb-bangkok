import {isPerp,positionPnl} from './order-markets.mjs';
import {TradingPreview} from './trading-preview.mjs';
import {L} from './execution-views.mjs';
import {escapeUI as e} from './product-experience.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {uiGlyph} from './product-composition.mjs';

let snapshot;
const data=()=>snapshot||(snapshot=new TradingPreview().snapshot());
const amount=value=>Number.isFinite(value)?value.toLocaleString('en-US',{maximumFractionDigits:2,minimumFractionDigits:2}):'—';
export function workbenchExampleRows(){
 const d=data();
 return d.runs.map(run=>{const position=d.positions.find(row=>row.previewId===run.previewId);const orders=d.orders.filter(row=>row.previewId===run.previewId),pending=orders.find(row=>row.id===run.pendingId);return {...run,position,state:pending?.status||run.state,name:L(run.strategyLabel.zh,run.strategyLabel.en),orders,pnl:position?(isPerp(position)?positionPnl(position):(position.markPrice-position.price)*position.qty):null};});
}
export function workbenchExampleNotices(){
 return [
  {id:'example:receipt',kind:'attention',exampleId:'btc-unknown',symbol:'BTC',text:L('订单回执待核对','Order receipt needs review'),detail:L('未确认成交结果，暂停重复下单。','The outcome is unconfirmed; do not submit again.'),age:null},
  {id:'example:chain',kind:'attention',exampleId:'btc-swap',symbol:'BTC',text:L('链上交易等待确认','On-chain trade awaiting confirmation'),detail:L('已提交的订单仍可能完成，请先核对状态。','A submitted order may still complete. Check its status first.'),age:null},
  {id:'example:pause',kind:'receipt',runId:'example:eth-range',exampleId:'eth-range',symbol:'ETH',text:L('策略已暂停，持仓继续保留','Strategy paused; position retained'),age:null},
  {id:'example:fill',kind:'receipt',runId:'example:sol-short',exampleId:'sol-short',symbol:'SOL',text:L('合约建仓已成交，保护规则随仓位生效','Perpetual entry filled; position protection applied'),age:null}
 ];
}
export function workbenchExamplesAvailable(trade,scope){
 return Boolean(trade)&&scope?.accountId==='SIM-01'&&scope.environment==='DEMO'&&!trade?.unreadableTrade&&!trade?.botSummary?.recoveryError&&!trade?.session&&!trade?.position&&!trade?.pending&&!trade?.discovery?.armed&&!(trade?.botBook?.runs?.length)&&!(trade?.orders?.length)&&!(trade?.events?.some(row=>['fill','order','risk'].includes(row.kind)));
}
export function workbenchExampleRunList(){
 const ids=['btc-trend','sol-short','eth-swap','btc-perp'];
 return `<div class="ops-run-list ops-example-runs">${workbenchExampleRows().filter(run=>ids.includes(run.previewId)).map(run=>`<button type="button" class="ops-run-row" data-ops-example="${run.previewId}"><span class="ops-run-heading">${tokenIcon(run.market.split('/')[0],{size:22})}<strong>${e(run.name)}</strong>${uiGlyph('chevron')}</span><span class="ops-run-market">${e(run.market)}<small>${run.profileId.toUpperCase().replace('-', ' · ')}</small></span><span class="ops-run-bottom"><span class="ops-run-state" data-state="${run.state}"><i></i>${run.state==='paused'?L('已暂停','Paused'):L('运行中','Running')}</span><b>${(run.pnl>0?'+':'')+amount(run.pnl)} USDT</b></span></button>`).join('')}</div>`;
}
export function workbenchExampleDetail(id){
 const rows=workbenchExampleRows(),run=rows.find(row=>row.previewId===id),orders=run?run.orders:data().orders;
 if(id!=='history'&&!run)return null;
 return `<header class="ops-example-heading"><div><span class="ops-example-tag">${L('模拟示例','Simulation example')}</span><h2>${run?e(run.name):L('交易记录示例','Example trade history')}</h2></div><button type="button" data-example-close aria-label="${L('关闭','Close')}">${uiGlyph('close')}</button></header><p class="ops-example-description">${L('用于查看运行与成交的呈现，不属于你的账户。','A preview of runs and fills, separate from your account.')}</p>${run?`<div class="ops-example-facts"><div><span>${L('交易市场','Market')}</span><b>${run.profileId.toUpperCase().replace('-',' · ')}</b></div><div><span>${L('交易对','Pair')}</span><b>${e(run.market)}</b></div><div><span>${L('状态','State')}</span><b>${L(...({paused:['已暂停','Paused'],unknown:['回执待核对','Receipt unconfirmed'],confirming:['链上确认中','Confirming']}[run.state]||['运行中','Running']))}</b></div><div><span>${L('方向 / 杠杆','Side / leverage')}</span><b>${(run.position?.direction||run.orders[0]?.direction)==='short'?L('空头','Short'):L('多头','Long')} · ${run.position?.leverage||run.orders[0]?.leverage||1}×</b></div></div>`:''}<div class="ops-example-history">${orders.map(order=>`<article><span>${tokenIcon(order.market.split('/')[0],{size:22})}<b>${e(order.market)}</b><small>${order.profileId?.toUpperCase().replace('-',' · ')||''}</small></span><span><b>${order.intent==='close'?L('平仓','Close'):L('开仓','Open')} · ${order.side==='buy'?L('买入','Buy'):L('卖出','Sell')}</b><small>${L(...({filled:['已成交','Filled'],partial:['部分成交','Partial'],'partial-cancelled':['部分成交后撤单','Part-filled · Cancelled'],cancelled:['已撤单','Cancelled'],rejected:['已拒绝','Rejected'],unknown:['回执待核对','Unconfirmed'],submitted:['已提交','Submitted'],confirming:['确认中','Confirming']}[order.status]||['处理中','Processing']))}</small></span><span><b>${amount(order.price)} USDT</b><small>${L('成交量','Filled')} ${(Number(order.qty||0)*Number(order.filled||0)).toLocaleString('en-US',{maximumFractionDigits:6})}</small></span></article>`).join('')}</div>`;
}
