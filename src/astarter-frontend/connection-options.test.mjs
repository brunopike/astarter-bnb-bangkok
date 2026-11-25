import test from 'node:test';import assert from 'node:assert/strict';
import {CONNECTION_OPTIONS,normalizeConnectionPreferences,demoCredentialIssue,apiCredentialIssue,applyCheckedTradingConnection,notificationAllowed,notificationRecipientIssue,connectionPreviewIssue,connectionReviewKey,connectionBilling,walletTradingProfile} from './connection-options.mjs?v=20261120c';
import {officialAgentModels,agentModelPlan,agentModelsIssue,normalizeAgentModels} from './agent-models.mjs';
import {normalizeConnections,mergeConnectionSection} from './connections.mjs?v=20261120c';
import * as connectionUI from './connections.mjs?v=20261120c';
import {normalizeTradingConnections,tradingConnections,preferredTradingConnection,connectionReturnContext,spendableSpotUsdt,spendableWalletUsdt,readBscSpotBalances,connectedSpotBalance,applySignedWallet,signedWalletSession,publicSpotBook,spotBookPerformance} from './connection-options.mjs?v=20261122b';
const shortcutButton=()=>({dataset:{connect:'exchange'},small:{textContent:''},attributes:{},querySelector(selector){assert.equal(selector,'small');return this.small;},setAttribute(key,value){this.attributes[key]=value;}});
test('trading shortcut renders the preferred perp or wallet status with its exact identity',()=>{
 const records=normalizeTradingConnections([
  {id:'spot',kind:'exchange',service:'binance',market:'spot'},
  {id:'perp',kind:'exchange',service:'binance',market:'perp'},
  {id:'wallet',kind:'wallet',service:'metamask',chain:'42161',venue:'hyperliquid'}
 ]);
 for(const [id,profileId,access,enabled,text]of [
  ['perp','cex-perp',{code:'ready',ready:true},'true',/交易权限可用|Trading access available/],
  ['wallet','dex-perp',{code:'wallet-authority',ready:false},'false',/钱包尚未授权交易|Wallet trading permission missing/]
 ]){
  const button=shortcutButton(),queries=[],c={exchange:true,tradingAccounts:records,preferredTradingConnection:id},before=structuredClone(c);
  connectionUI.updateTradingConnectionStatus(button,c,q=>{queries.push(q);return access;});
  assert.deepEqual(queries,[{connectionId:id,profileId}]);assert.equal(button.dataset.enabled,enabled);
  assert.match(button.small.textContent,text);assert.equal(button.title,button.attributes['aria-label']);
  assert.ok(button.title.endsWith(' · '+button.small.textContent));assert.equal(button.dataset.connect,'exchange');assert.deepEqual(c,before);
 }
});
test('trading shortcut cannot show a ready dot for a missing, unsupported, unknown or unready connection',()=>{
 const [perp,wallet]=normalizeTradingConnections([{id:'perp',kind:'exchange',service:'binance',market:'perp'},{id:'wallet',kind:'wallet',service:'metamask',chain:'1',venue:'wallet'}]);
 for(const [record,id,access,expectedCalls,text]of [
  [perp,'missing',{code:'ready',ready:true},0,/尚未选择|Not selected/],
  [wallet,'wallet',{code:'ready',ready:true},0,/此接入尚不能执行策略|This connection cannot execute strategies/],
  [perp,'perp',{code:'unknown',ready:true},1,/接入尚未检查|Connection needs checking/],
  [perp,'perp',{code:'ready',ready:false},1,/接入尚未检查|Connection needs checking/]
 ]){
  const button=shortcutButton();let calls=0;
  connectionUI.updateTradingConnectionStatus(button,{exchange:true,tradingAccounts:[record],preferredTradingConnection:id},()=>{calls++;return access;});
  assert.equal(calls,expectedCalls);assert.equal(button.dataset.enabled,'false');assert.match(button.small.textContent,text);
  assert.equal(button.attributes['aria-label'],button.title);
 }
});
test('contradictory ready results remain unchecked in every connection display without changing access data',()=>{
 const [record]=normalizeTradingConnections([{id:'perp',kind:'exchange',service:'binance',market:'perp'}]);
 const config={tradingAccounts:[record],preferredTradingConnection:record.id};
 for(const ready of [false,undefined,'true',1]){
  const access={code:'ready',ready},before=structuredClone(access),getAccess=()=>access;
  const state=connectionUI.connectionRecordStatus(record,getAccess);
  assert.equal(state.code,'connection-unchecked');assert.equal(state.access,access);
  for(const html of [connectionUI.connectionOverview(config,{getAccess}),connectionUI.savedConnectionCard(record,{getAccess})]){
   assert.match(html,/data-access-code="connection-unchecked"/);
   assert.match(html,/接入尚未检查|Connection needs checking/);
   assert.doesNotMatch(html,/交易权限可用|Trading access available|data-connection-disconnect=/);
  }
  const button=shortcutButton();connectionUI.updateTradingConnectionStatus(button,config,getAccess);
  assert.equal(button.dataset.enabled,'false');assert.equal(button.small.textContent,state.label);
  assert.ok(button.attributes['aria-label'].endsWith(' · '+state.label));assert.deepEqual(access,before);
 }
});
test('saved cards and the overview share exact access identity, including unsupported and unknown results',()=>{
 const records=normalizeTradingConnections([
  {id:'perp',kind:'exchange',service:'binance',market:'perp',accountId:'FUTURES-2',label:'Perp account'},
  {id:'eth',kind:'wallet',service:'metamask',chain:'1',venue:'wallet',accountId:'ETH-3',label:'Ethereum'}
 ]),queries=[];
 const getAccess=q=>{queries.push(q);return {code:'unknown',ready:true};};
 for(const record of records){
  const html=connectionUI.savedConnectionCard(record,{getAccess,returnDraft:true});
  assert.match(html,/data-access-code="(?:connection-unchecked|unsupported-route)"/);
  assert.doesNotMatch(html,/data-connection-disconnect=/);
  assert.match(html,new RegExp(`data-connection-use="${record.id}"`));
 }
 assert.deepEqual(queries,[{connectionId:'perp',profileId:'cex-perp'}]);
});
test('connection cards bind their actions to the saved identity without changing preference or permission',()=>{
 const [record]=normalizeTradingConnections([{id:'read',kind:'exchange',service:'binance',accountId:'RESEARCH-1',label:'Research'}]),before=structuredClone(record);
 const html=connectionUI.savedConnectionCard(record,{preferred:true,getAccess:()=>({code:'read-only',ready:false})});
 assert.match(html,/data-connection-edit="read"/);assert.match(html,/data-connection-disconnect="read"/);
 assert.doesNotMatch(html,/data-connection-prefer=|data-connection-use=/);assert.match(html,/data-access-code="read-only"/);
 assert.deepEqual(record,before);
});
test('account fields retain actual saved account identity and do not treat every nondefault account as disconnected',()=>{
 const html=connectionUI.connectionAccountFields({record:{accountId:'EXCHANGE-204'},label:'Main "account"',kind:'exchange',service:'okx'});
 assert.match(html,/readonly[^>]+value="EXCHANGE-204"/);assert.match(html,/Main &quot;account&quot;/);
 assert.doesNotMatch(html,/Not connected|尚未接入|<select|data-pref=/);
 const empty=connectionUI.connectionAccountFields({kind:'exchange',service:'okx'});
 assert.match(empty,/此平台账户尚未接入|Account not connected for this platform/);
 const existing=connectionUI.connectionAccountFields({record:{accountId:'<unsafe>'}});
 assert.match(existing,/value="&lt;unsafe&gt;"/);assert.doesNotMatch(existing,/<unsafe>/);
});
test('overview reads only the saved preferred connection and its exact market',()=>{
 const c=normalizeConnections({tradingAccounts:[
  {id:'spot',kind:'exchange',service:'binance',market:'spot',accountId:'SPOT-1',label:'Spot account'},
  {id:'perp',kind:'exchange',service:'binance',market:'perp',accountId:'PERP-2',label:'Perp account'}
 ],preferredTradingConnection:'perp'}),before=structuredClone(c),queries=[];
 const html=connectionUI.connectionOverview(c,{getAccess:q=>{queries.push(q);return {code:'connection-expired',ready:false};}});
 assert.deepEqual(queries,[{connectionId:'perp',profileId:'cex-perp'}]);
 assert.match(html,/Perp account/);assert.match(html,/PERP-2/);assert.match(html,/PERP/);
 assert.match(html,/data-access-code="connection-expired"/);assert.doesNotMatch(html,/data-access-code="ready"|SPOT-1/);
 assert.match(html,/data-section="exchange"/);assert.match(html,/data-cc="execution"/);
 assert.doesNotMatch(html,/data-cc="setup"/);assert.deepEqual(c,before);
});
test('wallet overview uses the wallet route and never borrows a default CEX check',()=>{
 const c=normalizeConnections({tradingAccounts:[{id:'wallet',kind:'wallet',service:'metamask',venue:'hyperliquid',chain:'42161',access:'read',accountId:'WALLET-1',label:'Research wallet'}],preferredTradingConnection:'wallet'}),queries=[];
 const html=connectionUI.connectionOverview(c,{getAccess:q=>{queries.push(q);return {code:'wallet-authority',ready:false};}});
 assert.deepEqual(queries,[{connectionId:'wallet',profileId:walletTradingProfile(c.tradingAccounts[0])}]);
 assert.match(html,/data-section="wallet"/);assert.match(html,/Hyperliquid/);assert.match(html,/data-access-code="wallet-authority"/);
});
test('missing, unknown and unsupported connections remain unverified in the overview',()=>{
 for(const c of [{tradingAccounts:[]},{tradingAccounts:[{id:'saved',kind:'exchange',service:'binance'}],preferredTradingConnection:'missing'}]){
  let calls=0;const html=connectionUI.connectionOverview(c,{getAccess:()=>{calls++;return {code:'ready',ready:true};}});
  assert.equal(calls,0);assert.doesNotMatch(html,/data-access-code="ready"/);assert.match(html,/尚未选择|Not selected/);
 }
 const c=normalizeConnections({tradingAccounts:[{id:'saved',kind:'exchange',service:'binance',label:'Saved account'}],preferredTradingConnection:'saved'});
 for(const access of [null,{code:'unknown-code',ready:true}]){
  const html=connectionUI.connectionOverview(c,{getAccess:()=>access});
  assert.match(html,/接入尚未检查|Connection needs checking/);
 }
 const unsupported=normalizeConnections({tradingAccounts:[{id:'unsupported',kind:'wallet',service:'metamask',chain:'1',venue:'wallet'}],preferredTradingConnection:'unsupported'});
 assert.equal(walletTradingProfile(unsupported.tradingAccounts[0]),null);
 let called=false;const html=connectionUI.connectionOverview(unsupported,{getAccess:()=>{called=true;return {code:'ready'};}});
 assert.equal(called,false);assert.match(html,/此接入尚不能执行策略|This connection cannot execute strategies/);
});
test('overview shows saved source preferences without exposing credentials or asserting a live connection',()=>{
 const c=normalizeConnections({data:false,ai:false,preferences:{data:{source:'custom',services:['coinglass'],key:'private-key-fixture'},ai:{source:'custom',service:'gateway',endpoint:'https://api.example.com/v1',key:'private-key-fixture'}},tradingAccounts:[{id:'safe',kind:'exchange',service:'binance',label:'Main <b>account</b>'}],preferredTradingConnection:'safe'}),before=structuredClone(c);
 const html=connectionUI.connectionOverview(c);
 assert.match(html,/CoinGlass/);assert.match(html,/已关闭|Off/);
 assert.doesNotMatch(html,/<b>account<\/b>|private-key-fixture|https:\/\/api.example.com/);
 for(const key of ['data','ai','notifications'])assert.match(html,new RegExp(`data-section="${key}"`));
 assert.deepEqual(c,before);
});
test('local status covers desktop product routes without adding a mobile or setup footer',()=>{
 for(const page of ['workbench','strategies','execution','signals','markets','tracking','assistant','logs','assets','profile','plans','topup','usage','billing','settings','risk']){
  assert.equal(connectionUI.connectionStatusVisible(page,901),true,page);
  assert.equal(connectionUI.connectionStatusVisible(page,1440),true,page);
 }
 for(const width of [320,430,900]){
  assert.equal(connectionUI.connectionStatusVisible('workbench',width),true);
  for(const page of ['strategies','signals','assistant','profile','settings'])assert.equal(connectionUI.connectionStatusVisible(page,width),false,page);
 }
 for(const page of ['setup','landing','login','',undefined])for(const width of [320,900,901,1440])assert.equal(connectionUI.connectionStatusVisible(page,width),false,String(page));
});
test('multiple trading connections retain only configuration and a compatible preferred identity',()=>{
 const accounts=normalizeTradingConnections([
  {id:'api-main',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01',label:'主账户接入',key:'fixture-private-key',secret:'fixture-private-key',verified:true},
  {id:'api-read',kind:'exchange',service:'binance',market:'spot',access:'read',accountId:'SIM-01',label:'只读接入'},
  {id:'wallet-main',kind:'wallet',service:'metamask',chain:'42161',access:'read',accountId:'SIM-01',label:'研究钱包',connected:true,authorized:true},
  {id:'api-main',kind:'exchange',service:'okx'},
  {id:'unknown',kind:'exchange',service:'unknown'}
 ]);
 assert.equal(accounts.length,3);assert.doesNotMatch(JSON.stringify(accounts),/fixture-private-key|verified|connected|authorized|secret/);
 const config=normalizeConnections({tradingAccounts:accounts,preferredTradingConnection:'api-read'});
 assert.equal(preferredTradingConnection(config,'cex-spot')?.id,'api-read');
 assert.equal(preferredTradingConnection(config,'dex-spot'),null);
 assert.equal(preferredTradingConnection({...config,preferredTradingConnection:'missing'},'cex-spot'),null);
 assert.equal(tradingConnections({...config,tradingAccounts:[]}).length,0);
});
test('connection registry preserves old preferences and does not invent a restored wallet',()=>{
 const legacy=normalizeConnections({preferences:{exchange:{service:'binance',market:'spot',access:'trade'}}});
 assert.equal(tradingConnections(legacy)[0].id,'legacy-exchange');
 assert.equal(tradingConnections(legacy).some(c=>c.kind==='wallet'),false);
 const config=normalizeConnections({...legacy,tradingAccounts:[...tradingConnections(legacy),{id:'read-two',kind:'exchange',service:'binance',market:'spot',access:'read',accountId:'SIM-01',label:'第二接入'}],preferredTradingConnection:'read-two'});
 assert.deepEqual(config.preferences,legacy.preferences);assert.equal(config.wallet,false);
 assert.equal(preferredTradingConnection(config,'cex-spot')?.id,'read-two');
 const walletDraft=normalizeConnections({...config,tradingAccounts:[...config.tradingAccounts,{id:'wallet-two',kind:'wallet',service:'phantom',access:'read',chain:'solana:mainnet',accountId:'SIM-01',label:'研究钱包'}]});
 const exchangeSave=mergeConnectionSection(config,walletDraft,'exchange');
 assert.equal(exchangeSave.tradingAccounts.some(c=>c.id==='wallet-two'),false);
 assert.equal(exchangeSave.preferredTradingConnection,'read-two');
});
test('official access works without provider credentials and has only the three product modes',()=>{
 const p=normalizeConnectionPreferences();assert.equal(normalizeConnectionPreferences(null).ai.source,'official');assert.equal(normalizeConnections(null).provider,'Astarter');
 assert.equal(p.data.source,'official');assert.equal(p.ai.source,'official');assert.equal(p.ai.service,'official');assert.equal(p.ai.model,'balanced');
 assert.equal(normalizeConnectionPreferences({ai:{service:'openrouter'}}).ai.source,'official');
 assert.equal(normalizeConnectionPreferences({ai:{source:'custom',service:'openrouter'}}).ai.source,'custom');
 for(const mode of ['balanced','fast','adaptive'])assert.equal(normalizeConnectionPreferences({ai:{source:'official',model:mode}}).ai.model,mode);
 assert.equal(normalizeConnectionPreferences({ai:{source:'official',service:'gateway',endpoint:'https://example.com/v1',modelId:'custom-model'}}).ai.service,'official');
});
test('each agent keeps its own model and version across source and preset changes',()=>{
 const defaults=normalizeConnectionPreferences();assert.equal(Object.keys(defaults.ai.agents||{}).length,18);
 const first=normalizeConnectionPreferences({ai:{source:'custom',service:'gateway',endpoint:'https://api.example.com/v1',model:'balanced',agents:{A01:{model:'my-market-model',version:'v2'},A13:{model:'my-decision-model',version:'2026-11'}}}});
 const next=normalizeConnectionPreferences({ai:{...first.ai,source:'official',model:'fast'}});
 assert.deepEqual(next.ai.agents.A01,{model:'my-market-model',version:'v2'});assert.deepEqual(next.ai.agents.A13,{model:'my-decision-model',version:'2026-11'});assert.equal(next.ai.customService,'gateway');assert.equal(next.ai.endpoint,'https://api.example.com/v1');
});
test('custom API plans retain safe metadata and never credentials, URL secrets, or fallback authority',()=>{
 const p=normalizeConnectionPreferences({data:{source:'custom',services:['coinglass','arbitrary'],key:'fixture-secret'},ai:{source:'custom',service:'gateway',endpoint:'https://api.example.com/v1',modelId:'research-model',key:'fixture-secret',fallback:true}});
 assert.equal(p.data.source,'custom');assert.deepEqual(p.data.services,['coinglass']);assert.equal(p.ai.source,'custom');assert.equal(p.ai.endpoint,'https://api.example.com/v1');assert.equal(p.ai.modelId,'research-model');
 assert.doesNotMatch(JSON.stringify(p),/fixture-secret|fallback/);
 for(const endpoint of ['javascript:alert(1)','https://u:fixture-secret@example.com','https://example.com?key=fixture-secret'])assert.equal(normalizeConnectionPreferences({ai:{source:'custom',service:'gateway',endpoint}}).ai.endpoint,'');
});
test('wallet selection offers only EVM and Solana and discards retired watch addresses',()=>{
 assert.deepEqual(CONNECTION_OPTIONS.wallet.map(o=>o.id),['metamask','phantom']);
 const p=normalizeConnectionPreferences({wallet:{service:'watch',network:'solana',address:'3'.repeat(44),connected:true}});
 assert.equal(p.wallet.service,'phantom');assert.equal(p.wallet.chain,'solana:mainnet');assert.equal(p.wallet.address,'');
 assert.equal(normalizeConnections({preferences:{wallet:{service:'watch',address:'0x'+'1'.repeat(40)}}}).wallet,false);
});
test('connection plans keep only known services and metadata, never credentials or connection claims',()=>{
 const data=normalizeConnections({exchange:true,preferences:{exchange:{service:'okx',market:'perp',access:'read',key:'secret-input',secret:'secret-input',connected:true},data:{services:['blockbeats','blockbeats','arbitrary']},wallet:{service:'watch',network:'evm',address:'0x'+'1'.repeat(40),seed:'secret-input'},ai:{service:'gateway',model:'deep',token:'secret-input'},notifications:{service:'telegram',events:['orders','orders','unknown'],key:'secret-input'}},secret:'secret-input'});
 assert.equal(data.preferences.exchange.service,'okx');assert.equal(data.preferences.exchange.market,'perp');assert.deepEqual(data.preferences.data.services,['blockbeats']);assert.deepEqual(data.preferences.notifications.events,['orders']);assert.equal(data.preferences.wallet.address,'');assert.doesNotMatch(JSON.stringify(data),/secret-input|connected|seed|token/);assert.equal(data.provider,'自有模型网关');
 const safe=normalizeConnectionPreferences({exchange:{service:'evil',access:'withdraw'},wallet:{address:'<script>'}});assert.equal(safe.exchange.service,'binance');assert.equal(safe.exchange.access,'read');assert.equal(safe.wallet.address,'');
});
test('API credential previews require invalid demo values and the right exchange fields',()=>{
 const okx=CONNECTION_OPTIONS.exchange.find(o=>o.id==='okx'),binance=CONNECTION_OPTIONS.exchange.find(o=>o.id==='binance');
 assert.deepEqual(okx.fields,['key','secret','passphrase']);assert.deepEqual(binance.fields,['key','secret']);
 assert.equal(demoCredentialIssue(okx,{key:'demo-key-123',secret:'demo-secret-123'}),'demo-only');
 assert.equal(demoCredentialIssue(okx,{key:'demo-key-123',secret:'demo-secret-123',passphrase:'demo-passphrase-123'}),null);
 assert.equal(demoCredentialIssue(binance,{key:'actual-looking-credential',secret:'secret-input'}),'demo-only');
 assert.equal(apiCredentialIssue(binance,{key:'actual-looking-credential',secret:'secret-input'}),null);
 assert.equal(apiCredentialIssue(binance,{key:'demo-binance-key',secret:'demo-binance-secret'}),'live-required');
 assert.equal(apiCredentialIssue(binance,{key:'short',secret:'secret-input'}),'invalid-credentials');
 assert.equal(apiCredentialIssue(okx,{key:'demo-key-123',secret:'demo-secret-123',passphrase:'demo-passphrase-123'}),null);
});
test('restored wallet preferences never restore a connected wallet or a private-key-shaped address',()=>{
 const restored=normalizeConnections({wallet:true,preferences:{wallet:{service:'watch',network:'evm',address:'a'.repeat(64),connected:true,authorized:true}}});
 assert.equal(restored.wallet,false);assert.equal(restored.preferences.wallet.address,'');
 assert.doesNotMatch(JSON.stringify(restored),/connected|authorized/);
});
test('wallet plans keep chain identity and discard retired watch address authority',()=>{
 const p=normalizeConnectionPreferences({wallet:{service:'phantom',network:'evm',chain:'1',address:'0x'+'1'.repeat(40)}});
 assert.equal(p.wallet.network,'solana');assert.equal(p.wallet.chain,'solana:mainnet');assert.equal(p.wallet.address,'');
 const q=normalizeConnectionPreferences({wallet:{service:'watch',network:'evm',chain:'8453',address:'0x'+'2'.repeat(40)}});assert.equal(q.wallet.chain,'8453');assert.equal(q.wallet.address,'');
 const bad=normalizeConnectionPreferences({wallet:{service:'watch',network:'evm',chain:'solana:mainnet',address:'a'.repeat(64)}});assert.equal(bad.wallet.chain,'56');assert.equal(bad.wallet.address,'');
});
test('saving one category cannot silently save unreviewed changes in another category',()=>{
 const saved=normalizeConnections({budget:12,preferences:{wallet:{service:'watch',network:'evm',address:'0x'+'1'.repeat(40)}}});
 const draft=normalizeConnections({...saved,budget:80,preferences:{...saved.preferences,exchange:{service:'okx',market:'perp',access:'read',secret:'fixture-secret'},wallet:{service:'phantom'},data:{services:[]}}});
 const result=mergeConnectionSection(saved,draft,'exchange');assert.equal(result.preferences.exchange.service,'okx');assert.equal(result.preferences.exchange.market,'perp');assert.deepEqual(result.preferences.wallet,saved.preferences.wallet);assert.deepEqual(result.preferences.data,saved.preferences.data);assert.equal(result.budget,12);assert.doesNotMatch(JSON.stringify(result),/fixture-secret|authorized|connected/);
 const wallet=mergeConnectionSection(saved,draft,'wallet');assert.equal(wallet.preferences.wallet.service,'phantom');assert.equal(wallet.preferences.exchange.service,'binance');assert.equal(wallet.wallet,false);
});
test('read-only is distinct from trading; risky demo permission results never qualify',()=>{
 assert.equal(connectionPreviewIssue('exchange',{access:'read'},'normal'),null);
 assert.equal(connectionPreviewIssue('exchange',{access:'read'},'withdraw'),'withdraw');
 assert.equal(connectionPreviewIssue('exchange',{access:'trade'},'trade-missing'),'permissions');
 assert.equal(connectionPreviewIssue('exchange',{access:'trade'},'no-ip'),'ip');
 assert.equal(connectionPreviewIssue('exchange',{access:'read'},'no-ip'),null);
 assert.equal(connectionPreviewIssue('wallet',{},'refused'),'refused');assert.equal(connectionPreviewIssue('wallet',{},'network'),'network');assert.equal(connectionPreviewIssue('exchange',{},'timeout'),'timeout');
});
test('connection identity follows provider, market, permissions, chain and resource mode',()=>{
 const a={service:'okx',market:'spot',access:'read'},key=connectionReviewKey('exchange',a);
 for(const patch of [{service:'bybit'},{market:'perp'},{access:'trade'}])assert.notEqual(connectionReviewKey('exchange',{...a,...patch}),key);
 assert.equal(connectionReviewKey('exchange',{...a,secret:'fixture-secret',connected:true}),key);
 const w={service:'watch',network:'evm',chain:'1',address:'0x'+'1'.repeat(40)};
 assert.notEqual(connectionReviewKey('wallet',w),connectionReviewKey('wallet',{...w,chain:'8453'}));
 assert.equal(connectionReviewKey('wallet',w),connectionReviewKey('wallet',{...w,address:'0x'+'2'.repeat(40)}));
 assert.notEqual(connectionReviewKey('ai',{source:'official',model:'balanced'}),connectionReviewKey('ai',{source:'official',model:'adaptive'}));
 assert.notEqual(connectionReviewKey('data',{source:'official'}),connectionReviewKey('data',{source:'custom',services:['coinglass']}));
});
test('external destination settings keep the independent in-app notice switch working',()=>{
 const c={notifications:true,preferences:{notifications:{service:'inapp',events:['orders']}}};
 assert.equal(notificationAllowed(c,{kind:'fill'}),true);assert.equal(notificationAllowed(c,{kind:'risk'}),false);assert.equal(notificationAllowed(c,{kind:'research'}),false);
 assert.equal(notificationAllowed({...c,preferences:{notifications:{service:'telegram',events:['orders']}}},{kind:'fill'}),true);
 assert.equal(notificationAllowed({...c,preferences:{notifications:{service:'email',events:['risk']}}},{kind:'fill'}),false);
 assert.equal(notificationAllowed({...c,notifications:false},{kind:'fill'}),false);
});

test('notification destinations survive channel switches without storing credentials or delivery claims',()=>{
 const source={service:'telegram',telegramChatId:' -1001234567890 ',email:' trader@example.com ',events:['orders'],token:'fixture-secret',verified:true};
 const first=normalizeConnectionPreferences({notifications:source}).notifications;
 assert.equal(first.telegramChatId,'-1001234567890');assert.equal(first.email,'trader@example.com');
 const switched=normalizeConnectionPreferences({notifications:{...first,service:'email'}}).notifications;
 assert.equal(switched.telegramChatId,first.telegramChatId);assert.equal(switched.email,first.email);
 assert.doesNotMatch(JSON.stringify(switched),/fixture-secret|token|verified/);
 const saved=normalizeConnections({notifications:true}),draft=normalizeConnections({notifications:true,preferences:{notifications:source}});
 const merged=mergeConnectionSection(saved,draft,'notifications');assert.equal(merged.preferences.notifications.telegramChatId,first.telegramChatId);assert.deepEqual(merged.preferences.exchange,saved.preferences.exchange);
});

test('notification destinations require valid addresses and numeric chat IDs',()=>{
 for(const email of ['a@example.com',' alerts+trades@example.co.uk '])assert.equal(notificationRecipientIssue({service:'email',email}),null);
 for(const email of ['',null,123,'a@','a@localhost','a@example.com\r\nBcc: x@y.com','<script>@example.com'])assert.equal(notificationRecipientIssue({service:'email',email}),'email');
 for(const telegramChatId of ['123456789','-1001234567890',' 123456789 '])assert.equal(notificationRecipientIssue({service:'telegram',telegramChatId}),null);
 for(const telegramChatId of ['',null,123,'0','@trader','123:bot-token','1e10','-100 123'])assert.equal(notificationRecipientIssue({service:'telegram',telegramChatId}),'telegramChatId');
 assert.equal(notificationRecipientIssue({service:'inapp'}),null);
 const invalid=normalizeConnectionPreferences({notifications:{email:'not-an-email',telegramChatId:'@trader'}}).notifications;
 assert.equal(invalid.email,'');assert.equal(invalid.telegramChatId,'');
});

test('own API call billing is separate for data and models and never permits paid fallback',()=>{
 assert.deepEqual(connectionBilling(),{data:'credits',ai:'credits',automaticFallback:false});
 assert.deepEqual(connectionBilling({data:{source:'custom'}}),{data:'own-api',ai:'credits',automaticFallback:false});
 assert.deepEqual(connectionBilling({ai:{source:'custom',service:'openrouter'}}),{data:'credits',ai:'own-api',automaticFallback:false});
 assert.deepEqual(connectionBilling({data:{source:'custom'},ai:{source:'custom',service:'gateway'}}),{data:'own-api',ai:'own-api',automaticFallback:false});
});

test('wallet success uses supported order routes and does not turn other networks into CEX strategies',()=>{
 assert.equal(walletTradingProfile({service:'metamask',chain:'42161'}),'dex-spot');
 assert.equal(walletTradingProfile({service:'metamask',chain:'1'}),null);
 assert.equal(walletTradingProfile({service:'metamask',chain:'8453'}),null);
 assert.equal(walletTradingProfile({service:'phantom'}),null);
 assert.equal(walletTradingProfile({service:'metamask',venue:'hyperliquid'}),'dex-perp');
});

test('official presets route distinct responsibilities and pin every listed version',()=>{
 for(const mode of ['balanced','fast','adaptive']){const assignments=officialAgentModels(mode);assert.equal(Object.keys(assignments).length,18);assert.ok(new Set(Object.values(assignments).map(a=>a.model)).size>=3);for(const assignment of Object.values(assignments)){assert.ok(assignment.version);assert.ok(assignment.version.startsWith(assignment.model));}}
 const before=officialAgentModels('balanced');assert.notDeepEqual(before.A13,officialAgentModels('fast').A13);assert.deepEqual(before,officialAgentModels('balanced'));
 const ai={source:'custom',model:'balanced',agents:{...before,A01:{model:'user/model',version:'v2'}}};const plan=agentModelPlan(ai);plan.assignments.A01.model='changed';assert.equal(ai.agents.A01.model,'user/model');assert.equal(agentModelsIssue(ai),null);
 ai.agents.A13.version='';assert.equal(agentModelsIssue(ai),'A13');
 const safe=normalizeAgentModels({A01:{model:'sk-or-v1-fixture-key',version:'v1'},A99:{model:'unused',version:'v1'}});assert.equal(safe.A01.model,'');assert.equal('A99' in safe,false);
});

test('return context keeps only the original draft references and never restores a form or credential',()=>{
 assert.deepEqual(connectionReturnContext({route:'bot',draftId:'D-123',version:4,runId:'SIM-RUN-12',amount:400,secret:'fixture-private-key',callback:'javascript:alert(1)'}),{route:'bot',draftId:'D-123',runId:'SIM-RUN-12',version:4});
 assert.equal(connectionReturnContext({route:'https://example.com'}),null);
 assert.deepEqual(connectionReturnContext({route:'setup',draftId:'<script>',version:-1,runId:'a'.repeat(64)}),{route:'setup'});
});


test('BlockBeats custom API plans require a demo key without changing official access or persisting credentials',()=>{
 const source=CONNECTION_OPTIONS.data.find(item=>item.id==='blockbeats');
 assert.deepEqual(source.fields,['key']);
 assert.equal(demoCredentialIssue(source,{}),'demo-only');
 assert.equal(demoCredentialIssue(source,{key:'demo-blockbeats-key'}),null);
 assert.equal(demoCredentialIssue(source,{key:'fixture-not-a-demo-key'}),'demo-only');
 const official=normalizeConnectionPreferences({data:{source:'official'}});assert.equal(official.data.source,'official');assert.deepEqual(official.data.services,[]);
 const custom=normalizeConnectionPreferences({data:{source:'custom',services:['blockbeats'],key:'demo-blockbeats-key'}});
 assert.deepEqual(custom.data.services,['blockbeats']);assert.equal(Object.hasOwn(custom.data,'key'),false);assert.doesNotMatch(JSON.stringify(custom),/demo-blockbeats-key/);
});

test('a live binance row replaces SIM-01 as the preferred connection',()=>{
 const connections=applyCheckedTradingConnection({exchange:true,tradingAccounts:[{id:'legacy-exchange',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01',label:'SIM-01'}],preferredTradingConnection:'legacy-exchange'},{connections:[{connectionId:'binance-spot',venue:'binance',kind:'CEX',market:'spot',permission:'trade',status:'connected',checkedAt:10,accountId:'BINANCE-SPOT',label:'Binance'}]});
 assert.equal(connections.preferredTradingConnection,'binance-spot');
 assert.equal(preferredTradingConnection(connections,'cex-spot')?.accountId,'BINANCE-SPOT');
 assert.equal(preferredTradingConnection(connections,'cex-spot')?.status,'connected');
 assert.equal(connections.tradingAccounts.find(record=>record.id==='legacy-exchange')?.accountId,'SIM-01');
 const withBalance=applyCheckedTradingConnection(connections,{connections:[{connectionId:'binance-spot',venue:'binance',kind:'CEX',market:'spot',permission:'trade',status:'connected',checkedAt:10,accountId:'BINANCE-SPOT',label:'Binance',available:88.25,locked:1.5}]});
 assert.equal(preferredTradingConnection(withBalance,'cex-spot')?.available,88.25);
 assert.equal(preferredTradingConnection(withBalance,'cex-spot')?.locked,1.5);
 assert.equal(connectedSpotBalance(withBalance),null);
 assert.equal(spendableSpotUsdt(withBalance,{accountId:'BINANCE-SPOT',connectionId:'binance-spot'},1000),null);
 assert.equal(spendableSpotUsdt(withBalance,{accountId:'SIM-01',connectionId:'binance-spot'},1000),null);
 const refreshed={...withBalance,spotBook:{symbol:'BTCUSDT',usdt:24.5,usdtLocked:0,btc:0.00012,btcPrice:60000,orders:[],history:[]}};
 assert.equal(spendableSpotUsdt(refreshed,{accountId:'BINANCE-SPOT',connectionId:'binance-spot'},1000),24.5);
 assert.equal(connectedSpotBalance(refreshed).equity,31.7);
 assert.equal(connectedSpotBalance({...refreshed,spotBook:{...refreshed.spotBook,equityUsd:40}}).equity,40);
 const stored=normalizeConnections({...refreshed,spotBook:{...refreshed.spotBook,equityUsd:40,orders:[{orderId:'1',side:'BUY',price:'1',origQty:'1',executedQty:'0',status:'NEW',clientOrderId:'astarter-secret'}]}});
 assert.equal(stored.spotBook.usdt,24.5);assert.equal(stored.spotBook.equityUsd,40);assert.equal(JSON.stringify(stored.spotBook).includes('astarter-secret'),false);
 assert.equal(connectedSpotBalance(stored).available,24.5);
 assert.equal(normalizeConnections({...stored,tradingAccounts:stored.tradingAccounts.map(record=>record.id==='binance-spot'?{...record,status:'disconnected',available:undefined,locked:undefined}:record)}).spotBook,undefined);
 const traded=publicSpotBook({symbol:'BTCUSDT',usdt:1,usdtLocked:0,btc:0.0006,btcPrice:62000,orders:[],trades:[{id:'1',orderId:'10',price:'60000',qty:'0.001',quoteQty:'60',commission:'0.06',commissionAsset:'USDT',isBuyer:true,time:1},{id:'2',orderId:'11',price:'61000',qty:'0.0004',quoteQty:'24.4',commission:'0.0244',commissionAsset:'USDT',isBuyer:false,time:2,clientOrderId:'secret'}]});
 const kept=publicSpotBook(traded);
 assert.equal(kept.trades.length,2);
 const result=spotBookPerformance(normalizeConnections({...withBalance,spotBook:traded}).spotBook);
 assert.ok(Math.abs(result.fees-0.0844)<1e-9);
 assert.ok(Math.abs(result.realized-0.3516)<1e-9);
 assert.ok(Math.abs(result.current-1.164)<1e-9);
 assert.ok(Math.abs(result.cumulative-1.5156)<1e-9);
 assert.equal(JSON.stringify(traded).includes('secret'),false);
 assert.equal(spotBookPerformance({...traded,trades:[]}),null);
 const fromOrders=spotBookPerformance(publicSpotBook({symbol:'BTCUSDT',usdt:1,usdtLocked:0,btc:0.0006,btcPrice:62000,orders:[],history:[{orderId:'10',side:'BUY',price:'0',origQty:'0.001',executedQty:'0.001',cummulativeQuoteQty:'60',status:'FILLED',time:1},{orderId:'11',side:'SELL',price:'61000',origQty:'0.0004',executedQty:'0.0004',status:'FILLED',time:2}],trades:[]}));
 assert.equal(fromOrders.fees,null);
 assert.ok(Math.abs(fromOrders.realized-0.4)<1e-9);
 assert.ok(Math.abs(fromOrders.current-1.2)<1e-9);
 assert.ok(Math.abs(fromOrders.cumulative-1.6)<1e-9);
});

test('a signed BNB Chain wallet is listed without replacing the preferred Binance account',async()=>{
 const address='0x1111111111111111111111111111111111111111';
 const checked=applyCheckedTradingConnection({tradingAccounts:[],preferredTradingConnection:''},{connections:[{connectionId:'binance-spot',venue:'binance',kind:'CEX',market:'spot',permission:'trade',status:'connected',checkedAt:10,accountId:'BINANCE-SPOT',label:'Binance'}]});
 const linked=applySignedWallet(checked,{address:address.toUpperCase(),chain:56});
 const wallet=linked.tradingAccounts.find(record=>record.id==='wallet-bsc');
 assert.equal(linked.preferredTradingConnection,'binance-spot');
 assert.equal(wallet.accountId,address);assert.equal(wallet.chain,'56');assert.equal(wallet.status,'connected');assert.equal(wallet.label,'0x1111…1111');
 assert.equal(walletTradingProfile(wallet),'dex-spot');
 assert.equal(applySignedWallet(linked,{address,chain:56}),linked);
 const card=connectionUI.savedConnectionCard(wallet);
 assert.match(card,/BNB Chain/);assert.match(card,/0x1111…1111/);assert.doesNotMatch(card,/data-connection-edit/);assert.doesNotMatch(card,new RegExp(address));
 const placeholder={id:'test-wallet',kind:'wallet',service:'metamask',network:'evm',chain:'56',venue:'wallet',access:'read',accountId:'SIM-01',label:'test',status:'connected'};
 const replaced=applySignedWallet({...linked,tradingAccounts:[...linked.tradingAccounts,placeholder]},{address,chain:56});
 assert.equal(replaced.tradingAccounts.some(record=>record.accountId==='SIM-01'&&record.chain==='56'),false);
 assert.equal(replaced.tradingAccounts.find(record=>record.id==='wallet-bsc').accountId,address);
 assert.equal(applySignedWallet(linked,null).tradingAccounts.some(record=>record.id==='wallet-bsc'),false);
 const route={accountId:address,connectionId:'wallet-bsc',venueId:'pancakeswap',profileId:'dex-spot',chainId:'56'};
 assert.equal(spendableWalletUsdt({walletBook:{accountId:address,usdt:18.25,btc:0.01}},route,100),18.25);
 assert.equal(spendableWalletUsdt({walletBook:{accountId:address,usdt:18.25,btc:0}},{...route,accountId:'0x'+'2'.repeat(40)},100),null);
 const hex=value=>'0x'+(BigInt(Math.round(value*1e6))*10n**12n).toString(16);
 const balances=await readBscSpotBalances(address.toUpperCase(),async(_url,options)=>{const token=JSON.parse(options.body).params[0].to;return {ok:true,json:async()=>({result:token.endsWith('7955')?hex(18.25):hex(0.5)})};});
 assert.deepEqual(balances,{accountId:address,usdt:18.25,btc:0.5});
 assert.equal(await readBscSpotBalances('0x123',async()=>({ok:true,json:async()=>({result:'0x0'})})),null);
 const checksum='0x'+'a'.repeat(20)+'A'.repeat(20);
 assert.deepEqual(signedWalletSession({session:{address:checksum,chain:'56'}}),{address:checksum.toLowerCase(),chain:56});
 assert.equal(signedWalletSession({session:{address:checksum,chain:1}}),null);
 assert.equal(applySignedWallet(linked,{address,chain:1}).tradingAccounts.some(record=>record.id==='wallet-bsc'),false);
});
