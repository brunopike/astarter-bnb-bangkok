import test from 'node:test';
import assert from 'node:assert/strict';
import {TradingAccess,accessTicketError} from './trading-access.mjs?v=20261120c';
import {normalizeConnections} from './connections.mjs?v=20261120c';
import {ExecutionFeed} from './execution-stream.mjs';
const stream={state:'LIVE',generation:1,scope:{accountId:'SIM-01',environment:'DEMO'}};
const connected=()=>normalizeConnections({preferences:{exchange:{service:'binance',market:'spot',access:'trade'}}});
test('stored connection metadata cannot restore permission or change an existing binding through preference',()=>{
 const config=normalizeConnections({...connected(),tradingAccounts:[
  {id:'api-main',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01',label:'主接入'},
  {id:'api-read',kind:'exchange',service:'binance',market:'spot',access:'read',accountId:'SIM-01',label:'只读接入'}
 ],preferredTradingConnection:'api-main'});
 const a=new TradingAccess(config);
 assert.equal(a.status(stream,{connectionId:'api-main'}).code,'connection-unchecked');
 a.configure(config,{section:'exchange',operation:'verify',connectionId:'api-main'});
 const access=a.status(stream,{connectionId:'api-main'}),ticket={accountId:'SIM-01',scopeGeneration:1,accessRevision:access.revision,connectionId:'api-main'};
 assert.equal(access.ready,true);assert.equal(accessTicketError(access,ticket),null);
 a.configure({...config,preferredTradingConnection:'api-read'},{section:'exchange',operation:'prefer',connectionId:'api-read'});
 assert.equal(accessTicketError(a.status(stream,{connectionId:'api-main'}),ticket),null);
 assert.equal(a.status(stream,{connectionId:'api-read'}).code,'connection-unchecked');
 a.configure(a.connections,{section:'exchange',operation:'verify',connectionId:'api-read'});
 assert.equal(a.status(stream,{connectionId:'api-read'}).code,'read-only');
 assert.equal(a.status(stream,{connectionId:'api-read',operation:'observe'}).ready,true);
 assert.equal(accessTicketError(a.status(stream,{connectionId:'api-read',operation:'observe'}),ticket),'review-again');
 assert.equal(new TradingAccess(a.connections).status(stream,{connectionId:'api-main'}).code,'connection-unchecked');
});
test('a disconnected bound connection keeps control and order queries available without borrowing another connection',()=>{
 const config=normalizeConnections({...connected(),tradingAccounts:[{id:'api-main',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01'}]});
 const a=new TradingAccess(config);a.configure(config,{section:'exchange',operation:'verify',connectionId:'api-main'});
 a.change('disconnect-api','Arbitrum','api-main');
 assert.equal(a.status(stream,{connectionId:'api-main'}).code,'api-offline');
 for(const operation of ['control','query'])assert.equal(a.status(stream,{connectionId:'api-main',operation}).ready,true);
 assert.equal(a.status(stream,{connectionId:'missing'}).code,'connection-missing');
 assert.equal(a.status({...stream,scope:{accountId:'SIM-02',environment:'DEMO'}},{connectionId:'api-main',operation:'control'}).ready,false);
});
test('wallet connection and per-trade permission remain separate and cannot authorize automatic trading',()=>{
 const config=normalizeConnections({...connected(),tradingAccounts:[{id:'wallet-main',kind:'wallet',service:'metamask',chain:'42161',accountId:'SIM-01',access:'read'}]});
 const a=new TradingAccess(config);a.configure(config,{section:'wallet',operation:'verify',connectionId:'wallet-main'});
 assert.equal(a.status(stream,{profileId:'dex-spot',connectionId:'wallet-main'}).code,'wallet-authority');
 assert.equal(a.status(stream,{profileId:'dex-spot',connectionId:'wallet-main',operation:'observe'}).ready,true);
 const approved=normalizeConnections({...config,tradingAccounts:[{...config.tradingAccounts[0],access:'confirm'}]});
 a.configure(approved,{section:'wallet',operation:'verify',connectionId:'wallet-main'});
 assert.equal(a.status(stream,{profileId:'dex-spot',connectionId:'wallet-main'}).ready,true);
 assert.equal(a.status(stream,{profileId:'dex-spot',connectionId:'wallet-main',operation:'auto'}).code,'wallet-authority');
 a.change('wallet-network','Ethereum','wallet-main');
 assert.equal(a.status(stream,{profileId:'dex-spot',connectionId:'wallet-main'}).code,'wallet-network');
});
test('the signed-in BSC wallet stays connected on BNB Chain',()=>{
 const address='0x1111111111111111111111111111111111111111';
 const config=normalizeConnections({...connected(),tradingAccounts:[{id:'wallet-bsc',kind:'wallet',service:'metamask',network:'evm',chain:'56',venue:'wallet',access:'confirm',accountId:address,label:'0x1111…1111',status:'connected'}]});
 const access=new TradingAccess(config).status(stream,{profileId:'dex-spot',connectionId:'wallet-bsc'});
 assert.equal(access.code,'wallet-held');
 assert.equal(access.ready,false);
 assert.equal(access.accountId,address);
 assert.equal(access.wallet.network,'BNB Chain');
});
test('all trade entrypoints share account, feed and permission checks',()=>{
 const a=new TradingAccess(connected());
 for(const profileId of ['cex-spot','cex-perp']){
  assert.equal(a.status(stream,{profileId}).ready,true);
  assert.equal(a.status({...stream,scope:{...stream.scope,accountId:'SIM-02'}},{profileId}).code,'other-account');
  assert.equal(a.status({...stream,state:'DISCONNECTED'},{profileId}).code,'view-offline');
 }
 a.change('disconnect-api');assert.equal(a.status(stream).code,'api-offline');
 a.change('reconnect-api');a.change('deny-api');assert.equal(a.status(stream).code,'permissions');
 const read=connected();read.preferences.exchange.access='read';a.configure(read,'exchange');
 assert.equal(a.status(stream).code,'read-only');assert.equal(a.status(stream,{operation:'observe'}).ready,true);
});
test('a view switch cannot borrow a ledger or stop already locked execution access',()=>{
 const a=new TradingAccess(connected()),other={...stream,scope:{accountId:'SIM-02',environment:'DEMO'}};
 assert.equal(a.status(other).ready,false);assert.equal(a.status(other,{ignoreView:true}).ready,true);
 a.change('disconnect-api');assert.equal(a.status(other,{ignoreView:true}).ready,false);
 const feed=new ExecutionFeed();feed.publish({seq:0,state:'idle',flow:{revision:0},orders:[],time:0});
 feed.switchScope({accountId:'SIM-02'});assert.equal(feed.data,null);
 feed.switchScope({accountId:'SIM-01'});feed.tick(1);assert.equal(feed.status.state,'LIVE');
});
test('recovery never reuses old account or connection confirmation',()=>{
 const a=new TradingAccess(connected()),access=a.status(stream),ticket={accountId:'SIM-01',scopeGeneration:1,accessRevision:access.revision};
 assert.equal(accessTicketError(access,ticket),null);
 a.change('disconnect-api');a.change('reconnect-api');
 assert.equal(accessTicketError(a.status(stream),ticket),'review-again');
 assert.equal(accessTicketError(access,{...ticket,accountId:'SIM-02'}),'review-again');
 assert.equal(accessTicketError({...access,scopeGeneration:3},ticket),'review-again');
});
test('wallet connection is shared in memory, never restored from a preference',()=>{
 const c=connected();c.preferences.wallet={service:'metamask',network:'evm',chain:'42161',address:''};
 const a=new TradingAccess(c);assert.equal(a.status(stream,{profileId:'dex-spot'}).code,'wallet-offline');
 a.configure(c,'wallet');assert.equal(a.status(stream,{profileId:'dex-spot'}).ready,true);
 a.change('wallet-network','Ethereum');assert.equal(a.status(stream,{profileId:'dex-spot'}).code,'wallet-network');
 a.change('disconnect-wallet');assert.equal(a.status(stream,{profileId:'dex-spot'}).code,'wallet-offline');
 assert.equal(new TradingAccess(c).wallet.connected,false);
});

test('stopping a local strategy remains possible without trading permission, but never from another account',()=>{
 const a=new TradingAccess(connected());a.change('disconnect-api');
 assert.equal(a.status(stream).ready,false);assert.equal(a.status(stream,{operation:'control'}).ready,true);
 assert.equal(a.status({...stream,scope:{accountId:'SIM-02',environment:'DEMO'}},{operation:'control'}).ready,false);
});

test('an unavailable account view offers switching instead of active fault controls',async()=>{
 const {scopeHeader}=await import('./execution-views.mjs');const a=new TradingAccess(connected()),f=new ExecutionFeed();
 f.publish({seq:0,state:'idle',flow:{revision:0},orders:[],time:0});f.switchScope({accountId:'SIM-02'});
 const html=scopeHeader({...f.status,access:a.status(f.status)});
 assert.match(html,/data-access-action="use-demo"/);assert.doesNotMatch(html,/data-id="disconnect-api"/);assert.equal(f.data,null);
});

test('wallet setup routes Hyperliquid separately and never grants authority from a retired watch plan',()=>{
 const c=connected(),a=new TradingAccess(c);
 c.preferences.wallet={service:'metamask',network:'evm',chain:'42161',venue:'hyperliquid'};a.configure(c,'wallet');
 assert.equal(a.wallet.connected,true);assert.equal(a.wallet.network,'Hyperliquid');
 c.preferences.wallet={service:'phantom',network:'solana',chain:'solana:mainnet'};a.configure(c,'wallet');
 assert.equal(a.wallet.network,'Solana');
 c.preferences.wallet={service:'watch',network:'evm',chain:'42161'};a.configure(c,'wallet');assert.equal(a.wallet.connected,false);
 const restored=new TradingAccess(normalizeConnections(c));assert.equal(restored.wallet.connected,false);
});

test('wallet access does not require enabling a CEX account or grant CEX permissions',()=>{
 const c=connected();c.exchange=false;const a=new TradingAccess(c);
 a.configure(c,'wallet');assert.equal(a.status(stream,{profileId:'dex-spot'}).ready,false);
 // The legacy paper route trades on Arbitrum. The default BSC wallet requires its own signed connection.
 c.preferences.wallet.chain='42161';a.configure(c,'wallet');
 assert.equal(a.status(stream,{profileId:'dex-spot'}).ready,true);
 assert.equal(a.status(stream,{profileId:'cex-spot'}).code,'account-off');
 a.change('disconnect-wallet');assert.equal(a.status(stream,{profileId:'dex-spot'}).code,'wallet-offline');
});

test('compact read-only notice retains its explanation and recovery without changing authority',async()=>{
 const {accessPanel}=await import('./trading-access-view.mjs');
 const config=connected();config.preferences.exchange.access='read';
 const runtime=new TradingAccess(config),access=runtime.status(stream),before=JSON.stringify(access);
 const view=accessPanel(access,{compact:true});
 assert.equal(JSON.stringify(access),before);assert.equal(runtime.status(stream).ready,false);
 assert.match(view,/data-access-action="enable-trade"/);assert.match(view,/data-access-profile="cex-spot"/);
 assert.match(view,/<details[^>]+access-info/);assert.match(view,/仍需确认金额和保护|review amounts and protection/);
 const offline=accessPanel({...access,code:'api-offline'});assert.match(offline,/<p>/);assert.match(offline,/data-access-action="reconnect-api"/);
});

test('bound read-only recovery opens its own connection without granting legacy trading access',async()=>{
 const {accessPanel}=await import('./trading-access-view.mjs');
 const config=normalizeConnections({...connected(),tradingAccounts:[{id:'api-read',kind:'exchange',service:'binance',market:'spot',access:'read',accountId:'SIM-01'}]});
 const runtime=new TradingAccess(config);runtime.configure(config,{section:'exchange',operation:'verify',connectionId:'api-read'});
 const before=JSON.stringify(config),view=accessPanel(runtime.status(stream,{connectionId:'api-read'}),{compact:true});
 assert.match(view,/data-connection-open="exchange"/);assert.match(view,/data-connection-id="api-read"/);assert.doesNotMatch(view,/data-access-action="enable-trade"/);
 assert.equal(JSON.stringify(config),before);assert.equal(runtime.status(stream,{connectionId:'api-read'}).ready,false);
});
test('bound resource and stream recovery retain the correct repair target',async()=>{
 const {accessPanel}=await import('./trading-access-view.mjs'),base={connectionId:'api-main',profileId:'cex-spot',accountId:'SIM-01',ready:false};
 assert.match(accessPanel({...base,code:'data-off'}),/data-connection-open="data"/);
 assert.match(accessPanel({...base,code:'ai-off'}),/data-connection-open="ai"/);
 assert.match(accessPanel({...base,code:'view-offline'}),/data-access-action="retry-read"/);
});
