import test from 'node:test';
import assert from 'node:assert/strict';
import {TradingAccess,tradingConnectionContract,connectionPreferenceKey,preferredConnectionFor,ACCESS_COPY} from './trading-access.mjs';
import {normalizeTradingConnections,normalizeConnectionPreferences} from './connection-options.mjs';

// Card A1 fallback: local fixture state only. Nothing here proves a venue connection.
const stream={state:'LIVE',generation:1,scope:{accountId:'SIM-01',environment:'DEMO'}};
const config=(records,extra={})=>({exchange:true,data:true,ai:true,wallet:false,notifications:true,preferences:normalizeConnectionPreferences(),tradingAccounts:normalizeTradingConnections(records),preferredTradingConnection:'',...extra});
const RECORDS=[
 {id:'api-main',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01',label:'Main'},
 {id:'api-read',kind:'exchange',service:'binance',market:'spot',access:'read',accountId:'SIM-01',label:'Read only'},
 {id:'api-perp',kind:'exchange',service:'okx',market:'perp',access:'read',accountId:'UNCONNECTED',label:'OKX perp'},
 {id:'wallet-arb',kind:'wallet',service:'metamask',chain:'42161',access:'confirm',accountId:'SIM-01',label:'Arbitrum wallet'},
 {id:'wallet-hl',kind:'wallet',service:'metamask',chain:'42161',venue:'hyperliquid',access:'read',accountId:'SIM-01',label:'HL wallet'}
];

test('each saved connection exposes the A1 fields, with status and checked time only from a check',()=>{
 let at=1000;const c=config(RECORDS),a=new TradingAccess(c,{now:()=>at});
 assert.deepEqual(a.contract('api-main'),{connectionId:'api-main',venue:'binance',venueType:'CEX',market:'spot',chain:'',label:'Main',accountId:'SIM-01',permissions:['read','trade'],status:'unchecked',checkedAt:null});
 assert.deepEqual(a.contract('api-perp'),{connectionId:'api-perp',venue:'okx',venueType:'CEX',market:'perp',chain:'',label:'OKX perp',accountId:'UNCONNECTED',permissions:['read'],status:'unchecked',checkedAt:null});
 assert.deepEqual(a.contract('wallet-arb'),{connectionId:'wallet-arb',venue:'wallet',venueType:'DEX',market:'spot',chain:'42161',label:'Arbitrum wallet',accountId:'SIM-01',permissions:['read','confirm'],status:'unchecked',checkedAt:null});
 assert.deepEqual(a.contract('wallet-hl'),{connectionId:'wallet-hl',venue:'hyperliquid',venueType:'DEX',market:'perp',chain:'42161',label:'HL wallet',accountId:'SIM-01',permissions:['read'],status:'unchecked',checkedAt:null});
 assert.equal(a.contract('missing'),null);assert.equal(a.status(stream,{connectionId:'api-main'}).checkedAt,null);
 a.configure(c,{section:'exchange',operation:'verify',connectionId:'api-main'});
 assert.equal(a.contract('api-main').status,'connected');assert.equal(a.contract('api-main').checkedAt,1000);
 const access=a.status(stream,{connectionId:'api-main'});assert.equal(access.ready,true);assert.equal(access.checkedAt,1000);
 assert.equal(a.contract('api-read').status,'unchecked');assert.equal(a.contract('api-read').checkedAt,null);
 at=2000;
 for(const [action,status]of [['expire-connection','expired'],['disconnect-api','disconnected'],['deny-api','denied']]){
  a.change(action,'Arbitrum','api-main');
  assert.equal(a.contract('api-main').status,status);assert.equal(a.contract('api-main').checkedAt,1000);assert.equal(a.status(stream,{connectionId:'api-main'}).ready,false);
 }
 at=3000;a.configure(c,{section:'exchange',operation:'verify',connectionId:'api-main'});
 assert.deepEqual([a.contract('api-main').status,a.contract('api-main').checkedAt],['connected',3000]);
});

test('a changed or restored configuration is unchecked again and keeps no old checked time',()=>{
 const c=config(RECORDS),a=new TradingAccess(c,{now:()=>5000});
 a.configure(c,{section:'exchange',operation:'verify',connectionId:'api-main'});
 const edited=config(RECORDS.map(r=>r.id==='api-main'?{...r,access:'read'}:r));
 a.configure(edited,{section:'exchange',operation:'prefer',connectionId:'api-main'});
 assert.deepEqual(a.contract('api-main'),{connectionId:'api-main',venue:'binance',venueType:'CEX',market:'spot',chain:'',label:'Main',accountId:'SIM-01',permissions:['read'],status:'unchecked',checkedAt:null});
 const access=a.status(stream,{connectionId:'api-main'});assert.equal(access.code,'connection-unchecked');assert.equal(access.checkedAt,null);
 const restored=new TradingAccess(c,{now:()=>6000});
 for(const record of c.tradingAccounts)assert.deepEqual([restored.contract(record.id).status,restored.contract(record.id).checkedAt],['unchecked',null]);
 assert.equal(tradingConnectionContract(c.tradingAccounts[0],{state:'connected',key:'another-binding',checkedAt:5000}).status,'unchecked');
});

test('withdrawal is never a permission of any saved connection',()=>{
 const c=config([...RECORDS,{id:'api-w',kind:'exchange',service:'binance',market:'spot',access:'withdraw',accountId:'SIM-01'},{id:'wallet-w',kind:'wallet',service:'metamask',chain:'42161',access:'withdraw',accountId:'SIM-01'}]),a=new TradingAccess(c);
 assert.deepEqual(a.contract('api-w').permissions,['read']);assert.deepEqual(a.contract('wallet-w').permissions,['read']);
 for(const record of c.tradingAccounts){
  a.configure(c,{section:record.kind,operation:'verify',connectionId:record.id});
  const view=a.contract(record.id);assert.equal(view.status,'connected');
  assert.ok(view.permissions.every(permission=>['read','trade','confirm'].includes(permission)),record.id);assert.doesNotMatch(JSON.stringify(view),/withdraw/i);
 }
});

test('preference keys are per market for exchanges and per chain for wallets',()=>{
 const [main,read,perp,arb,hl,eth,sol]=normalizeTradingConnections([...RECORDS,{id:'wallet-eth',kind:'wallet',service:'metamask',chain:'1',accountId:'SIM-01'},{id:'wallet-sol',kind:'wallet',service:'phantom',accountId:'SIM-01'}]);
 assert.equal(connectionPreferenceKey(main),'cex-spot');assert.equal(connectionPreferenceKey(read),'cex-spot');assert.equal(connectionPreferenceKey(perp),'cex-perp');
 assert.equal(connectionPreferenceKey(arb),'dex-spot:42161');assert.equal(connectionPreferenceKey(hl),'dex-perp:42161');
 for(const record of [eth,sol,null,undefined,{}])assert.equal(connectionPreferenceKey(record),null);
});

test('each market or chain has its own preference, and the single saved preference only covers its own market',()=>{
 const c=config(RECORDS,{preferredTradingConnection:'api-main'}),preferences={'cex-spot':'api-read','cex-perp':'api-perp','dex-spot:42161':'wallet-arb'};
 for(const [key,id]of Object.entries(preferences)){
  const preferred=preferredConnectionFor(c,key,preferences);
  assert.deepEqual([preferred.state,preferred.connectionId,preferred.record.id,preferred.code],['valid',id,id,null]);
 }
 assert.equal(preferredConnectionFor(c,'dex-perp:42161',preferences).state,'none');
 const single=preferredConnectionFor(c,'cex-spot');assert.equal(single.state,'valid');assert.equal(single.record.id,'api-main');
 for(const key of ['cex-perp','dex-spot:42161','dex-perp:42161'])assert.deepEqual(preferredConnectionFor(c,key),{key,connectionId:'',record:null,state:'none',code:null});
 const legacy={exchange:true,preferences:normalizeConnectionPreferences({exchange:{service:'binance',market:'spot',access:'trade'}})};
 assert.equal(preferredConnectionFor(legacy,'cex-spot').record.id,'legacy-exchange');assert.equal(preferredConnectionFor(legacy,'cex-perp').state,'none');
 assert.equal(preferredConnectionFor(null,'cex-spot').state,'none');
});

test('an invalid preference requires reselection and never switches to another connection',()=>{
 const c=config(RECORDS,{preferredTradingConnection:'api-main'});
 assert.deepEqual(preferredConnectionFor(c,'cex-spot',{'cex-spot':'removed-connection'}),{key:'cex-spot',connectionId:'removed-connection',record:null,state:'invalid',code:'connection-missing'});
 assert.deepEqual(preferredConnectionFor(c,'cex-spot',{'cex-spot':'api-perp'}),{key:'cex-spot',connectionId:'api-perp',record:null,state:'invalid',code:'connection-market'});
 assert.deepEqual(preferredConnectionFor(c,'dex-spot:42161',{'dex-spot:42161':'wallet-hl'}),{key:'dex-spot:42161',connectionId:'wallet-hl',record:null,state:'invalid',code:'connection-market'});
 for(const value of ['',null,42,{id:'api-main'}])assert.deepEqual(preferredConnectionFor(c,'cex-spot',{'cex-spot':value}),{key:'cex-spot',connectionId:'',record:null,state:'none',code:null});
 // The single saved id, when the key has no entry of its own: an id that no record has requires
 // reselection under every key, an empty or non-text value gives none, and no record is returned.
 const stale=config(RECORDS,{preferredTradingConnection:'removed-connection'});
 for(const key of ['cex-spot','cex-perp','dex-spot:42161','dex-perp:42161'])assert.deepEqual(preferredConnectionFor(stale,key),{key,connectionId:'removed-connection',record:null,state:'invalid',code:'connection-missing'});
 assert.deepEqual(preferredConnectionFor(stale,'cex-spot',{'cex-perp':'api-perp'}),{key:'cex-spot',connectionId:'removed-connection',record:null,state:'invalid',code:'connection-missing'});
 assert.equal(preferredConnectionFor(stale,'cex-spot',{'cex-spot':'api-read'}).record.id,'api-read');
 for(const value of ['',null,undefined,42])assert.deepEqual(preferredConnectionFor(config(RECORDS,{preferredTradingConnection:value}),'cex-spot'),{key:'cex-spot',connectionId:'',record:null,state:'none',code:null});
 assert.equal(preferredConnectionFor({exchange:false,preferredTradingConnection:'removed-connection'},'cex-spot').state,'none');
 assert.match(ACCESS_COPY['connection-missing'][2],/重新选择/);assert.match(ACCESS_COPY['connection-missing'][3],/Another account will not be used/);
 assert.match(ACCESS_COPY['connection-market'][2],/请选择/);assert.match(ACCESS_COPY['connection-market'][3],/Choose a connection matching/);
 const a=new TradingAccess(c);
 for(const record of c.tradingAccounts)a.configure(c,{section:record.kind,operation:'verify',connectionId:record.id});
 assert.equal(a.status(stream,{connectionId:'removed-connection'}).code,'connection-missing');assert.equal(a.status(stream,{connectionId:''}).code,'connection-missing');
 assert.equal(a.status(stream,{connectionId:'api-read',profileId:'cex-perp'}).code,'connection-market');
});
