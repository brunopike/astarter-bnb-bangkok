import {venueIcon,venueLogo} from './brand-icons.mjs';
import {L} from './execution-views.mjs';
export const DEFAULT_CONTEXT={connectorId:'binance-spot-demo',accountId:'SIM-01',venueId:'binance',marketType:'SPOT',environment:'DEMO'};
export const CAPABILITIES=[
 {id:'binance-spot-demo',name:'Binance',kind:'CEX',market:'SPOT',accountId:'SIM-01',demo:true,liveVerified:false,phase:['本地模拟可用','Local simulation']},
 {id:'binance-perp',name:'Binance',kind:'CEX',market:'USDT PERP',demo:false,liveVerified:false,phase:['首批接入规划','First integration planned']},
 {id:'okx',name:'OKX',kind:'CEX',market:'SPOT / PERP',demo:false,liveVerified:false,phase:['未适配','Not adapted']},
 {id:'bybit',name:'Bybit',kind:'CEX',market:'SPOT / PERP',demo:false,liveVerified:false,phase:['未适配','Not adapted']},
 {id:'wallet',name:'EVM Wallet',kind:'WALLET',market:'ON-CHAIN',demo:false,liveVerified:false,phase:['未连接','Not connected']},
 {id:'dex',name:'DEX / Hyperliquid',kind:'DEX',market:'SPOT / PERP',demo:false,liveVerified:false,phase:['研究规划','Research planned']},
 {id:'tradfi',name:'TradFi',kind:'BROKER',market:'EQUITIES / FX',demo:false,liveVerified:false,phase:['研究样例','Research fixtures']}
];
export function contextError(context=DEFAULT_CONTEXT){const c=CAPABILITIES.find(c=>c.id===context.connectorId);return c?.demo&&context.accountId==='SIM-01'&&context.environment==='DEMO'&&context.marketType==='SPOT'?null:'当前账户、市场或环境未适配模拟执行；可继续研究。';}
export function setupFingerprint(s){const d=s.drafts.find(d=>d.id===s.selectedDraftId);return JSON.stringify([s.setupContext||DEFAULT_CONTEXT,s.scope,d?.id,d?.version,s.risk.version,s.budget.daily,s.budget.byok,d?.protection||null,s.accessRevision||null,d?.market||null,d?.planVariant||'baseline',d?.executionRoute||null,d?.botParameters||null,...(d?.simulationReference?[d.simulationReference]:[])]);}
export function setupPrecheck(s){const v=s.validations.find(v=>v.id===s.setupPrecheckId);return v?.status==='passed'&&v.configurationHash===setupFingerprint(s)&&s.clock<v.expiresAt?v:null;}
export function capabilityDirectory(){return `<section class="p-card" data-localized-ui><h2>${L('策略自动执行能力','Automated strategy availability')}</h2><p class="p-footnote">${L('AI 信号支持 CEX / DEX 的现货与永续合约单笔模拟。下表为策略自动执行范围，仍仅开放现货剧本；没有实盘连接。','AI Signals supports one-shot CEX/DEX spot and perpetual demos. Automated strategies below remain spot-only fixtures. No live connection exists.')}</p><div class="capability-grid">${CAPABILITIES.map(c=>`<article class="capability-card"><small>${c.kind} · ${c.market}</small><h3>${venueLogo(c.id)?venueIcon(c.id,{size:28}):venueLogo(c.name)?venueIcon(c.name,{size:28}):''}${c.name}</h3><span class="contract-pill ${c.demo?'good':''}">${L(...c.phase)}</span><p>${c.demo?'SIM-01 · DEMO':L('执行不可用','Execution unavailable')}</p></article>`).join('')}</div></section>`;}
