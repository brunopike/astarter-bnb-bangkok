import {tradingConnections,preferredTradingConnection,walletTradingProfile,WALLET_NETWORKS} from './connection-options.mjs?v=20261120c';
const bindingKey=r=>JSON.stringify([r.id,r.kind,r.accountId,r.service,r.market,r.access,r.chain,r.venue]);
// Local access fixtures; no credentials, wallet signatures or live permissions.
export class TradingAccess {
 constructor(connections,{now=Date.now}={}){this.now=now;this.revision=0;this.sessions=new Map();this.wallet={connected:false,network:'',identity:''};this.configure(connections,'exchange');}
 configure(connections,section){
  this.connections=connections;
  if(section&&typeof section==='object'){
   const record=tradingConnections(connections).find(r=>r.id===section.connectionId);
   if(!record||record.kind!==section.section)return;
   if(section.operation==='verify'){const previous=this.sessions.get(record.id);this.sessions.set(record.id,{state:'connected',revision:(previous?.revision||0)+1,key:bindingKey(record),network:record.kind==='wallet'?(record.venue==='hyperliquid'?'Hyperliquid':WALLET_NETWORKS.find(n=>n.id===record.chain)?.name||''):'',identity:record.kind==='wallet'?'SIM-WALLET-'+record.id:'',checkedAt:this.now()});}
   if(section.operation==='disconnect')this.change(record.kind==='wallet'?'disconnect-wallet':'disconnect-api','',record.id);
   return;
  }
  if(section==='exchange')this.exchange=connections.exchange?'connected':'disconnected';
  if(section==='wallet'){
   const p=connections.preferences.wallet;
   this.wallet=['metamask','phantom'].includes(p.service)?{connected:true,network:p.venue==='hyperliquid'?'Hyperliquid':({'42161':'Arbitrum','1':'Ethereum','8453':'Base','solana:mainnet':'Solana'})[p.chain]||'',identity:'SIM-WALLET-'+(++this.revision)}:{connected:false,network:'',identity:''};
  }
  this.revision++;
 }
 change(action,network='Arbitrum',connectionId){
  if(connectionId!==undefined){const current=this.sessions.get(connectionId);if(!current)return;
   const state=action.startsWith('disconnect-')?'disconnected':action==='deny-api'?'denied':action==='expire-connection'?'expired':current.state;
   this.sessions.set(connectionId,{...current,state,revision:current.revision+1,...(action==='wallet-network'?{network}:{})});return;
  }
  if(action==='disconnect-api')this.exchange='disconnected';
  if(action==='deny-api')this.exchange='denied';
  if(action==='reconnect-api')this.exchange='connected';
  if(action==='disconnect-wallet')this.wallet={connected:false,network:'',identity:''};
  if(action==='connect-wallet')this.wallet={connected:true,network,identity:'SIM-WALLET-'+(this.revision+1)};
  if(action==='wallet-network')this.wallet={...this.wallet,network};
  this.revision++;
 }
 status(stream,{profileId='cex-spot',operation='entry',ignoreView=false,connectionId}={}){
  if(connectionId!==undefined&&connectionId!==null)return this.boundStatus(stream,{profileId,operation,ignoreView,connectionId});
  const scope=stream.scope||{},c=this.connections,dex=profileId.startsWith('dex');
  let code='ready';
  if(!ignoreView&&(scope.accountId!=='SIM-01'||scope.environment!=='DEMO'))code='other-account';
  else if(!ignoreView&&stream.state!=='LIVE')code=['REPLAYING','RESNAPSHOTTING'].includes(stream.state)?'reading':'view-offline';
  else if(operation==='control')code='ready';
  else if(!dex&&!c.exchange)code='account-off';
  else if(!dex&&this.exchange==='disconnected')code='api-offline';
  else if(!dex&&this.exchange==='denied')code='permissions';
  else if(!dex&&c.preferences.exchange.service!=='binance')code='unsupported-route';
  else if(!dex&&operation!=='observe'&&c.preferences.exchange.access!=='trade')code='read-only';
  else if(operation!=='exit'&&!c.data)code='data-off';
  else if(operation!=='exit'&&!c.ai)code='ai-off';
  else if(dex&&!this.wallet.connected)code='wallet-offline';
  else if(dex&&this.wallet.network!==(profileId==='dex-perp'?'Hyperliquid':'Arbitrum'))code='wallet-network';
  if(code==='ready'&&operation==='observe'&&!dex&&c.preferences.exchange.access!=='trade')code='observe-ready';
  return {code,ready:code==='ready'||code==='observe-ready',revision:this.revision,scopeGeneration:stream.generation,accountId:scope.accountId,environment:scope.environment,profileId,exchange:this.exchange,trade:c.preferences.exchange.access==='trade',wallet:{...this.wallet}};
 }
 boundStatus(stream,{profileId,operation,ignoreView,connectionId}){
  const record=tradingConnections(this.connections).find(r=>r.id===connectionId),session=this.sessions.get(connectionId),scope=stream.scope||{},dex=record?.kind==='wallet';
  let code='ready';
  if(!record)code='connection-missing';
  else if(record.accountId==='BINANCE-SPOT'&&['unchecked','connected','disconnected','denied','expired'].includes(record.status)){
   if(record.status==='expired')code='connection-expired';
   else if(record.status==='denied')code='exchange-denied';
   else if(record.status==='disconnected')code=record.reason==='restricted-location'?'exchange-region':'exchange-offline';
   else if(record.status==='connected'&&record.access==='read')code=operation==='observe'?'observe-ready':'exchange-read';
   else if(record.status==='connected'&&record.access==='trade')code=operation==='observe'?'observe-ready':'exchange-trade-held';
   else code='connection-unchecked';
   return {code,ready:code==='observe-ready',connectionId,revision:session?.revision||0,scopeGeneration:stream.generation,accountId:record.accountId,environment:'LIVE-CHECK',profileId,exchange:record.status==='connected'?'connected':'disconnected',trade:false,wallet:{connected:false,network:'',identity:''}};
  }
  else if(record.kind==='wallet'&&record.chain==='56'&&record.venue!=='hyperliquid'&&record.status==='connected'&&/^0x[0-9a-f]{40}$/.test(record.accountId||'')){
   code=record.access==='read'?'observe-ready':'wallet-held';
   return {code,ready:code==='observe-ready',connectionId,revision:session?.revision||0,scopeGeneration:stream.generation,accountId:record.accountId,environment:'LIVE-CHECK',profileId,exchange:'disconnected',trade:false,wallet:{connected:true,network:'BNB Chain',identity:record.label||''}};
  }
  else if(record.accountId!=='SIM-01'||!ignoreView&&(scope.accountId!==record.accountId||scope.environment!=='DEMO'))code='other-account';
  else if(['control','query'].includes(operation))code='ready';
  else if(!ignoreView&&stream.state!=='LIVE')code=['REPLAYING','RESNAPSHOTTING'].includes(stream.state)?'reading':'view-offline';
  else if((dex?walletTradingProfile(record):'cex-'+record.market)!==profileId)code='connection-market';
  else if(!session||session.key!==bindingKey(record))code='connection-unchecked';
  else if(session.state==='expired')code='connection-expired';
  else if(session.state==='disconnected')code=dex?'wallet-offline':'api-offline';
  else if(session.state==='denied')code='permissions';
  else if(!dex&&record.service!=='binance')code='unsupported-route';
  else if(dex&&session.network!==(profileId==='dex-perp'?'Hyperliquid':'Arbitrum'))code='wallet-network';
  else if(dex&&operation!=='observe'&&(record.access!=='confirm'||operation==='auto'))code='wallet-authority';
  else if(!dex&&operation!=='observe'&&record.access!=='trade')code='read-only';
  else if(operation!=='exit'&&!this.connections.data)code='data-off';
  else if(operation!=='exit'&&!this.connections.ai)code='ai-off';
  if(code==='ready'&&operation==='observe'&&record.access!=='trade'&&record.access!=='confirm')code='observe-ready';
  return {code,ready:['ready','observe-ready'].includes(code),connectionId,checkedAt:record&&session?.key===bindingKey(record)?session.checkedAt??null:null,revision:session?.revision||0,scopeGeneration:stream.generation,accountId:record?.accountId,environment:'DEMO',profileId,exchange:dex?'disconnected':session?.state||'unchecked',trade:record?.access==='trade',wallet:{connected:Boolean(dex&&session?.state==='connected'),network:session?.network||'',identity:session?.identity||''}};
 }
 // A1 contract view of one saved record, or null. See tradingConnectionContract.
 contract(connectionId){const record=tradingConnections(this.connections).find(r=>r.id===connectionId);return record?tradingConnectionContract(record,this.sessions.get(connectionId)):null;}
}

// A1 contract fields (trading-connection-v1) of one normalized record: connectionId,
// venue, CEX/DEX, spot/perp, chain, permissions, status and checked time. Local fixture
// state only: no venue, credential or balance is read, and withdrawal is never a permission.
export function tradingConnectionContract(record,session=null){
 const dex=record.kind==='wallet',checked=Boolean(session&&session.key===bindingKey(record));
 return {connectionId:record.id,venue:dex?record.venue:record.service,venueType:dex?'DEX':'CEX',market:dex?(record.venue==='hyperliquid'?'perp':'spot'):record.market,chain:dex?record.chain:'',label:record.label,accountId:record.accountId,permissions:record.access==='read'?['read']:['read',record.access],status:checked?session.state:'unchecked',checkedAt:checked?session.checkedAt??null:null};
}
// One preference per market/chain: a CEX key is the market profile, a wallet key adds
// the chain. A record without an order route has no key and cannot be preferred.
export function connectionPreferenceKey(record){
 if(record?.kind==='exchange')return 'cex-'+record.market;
 const profileId=record?.kind==='wallet'?walletTradingProfile(record):null;
 return profileId?profileId+':'+record.chain:null;
}
// A preference is only a default for new drafts. A missing or mismatched preferred record is reported
// for reselection, and so is a single saved id that no record has; another record is never substituted.
export function preferredConnectionFor(connections,key,preferences=null){
 const records=tradingConnections(connections),own=preferences&&typeof preferences==='object'&&!Array.isArray(preferences)&&Object.hasOwn(preferences,key)?preferences[key]:undefined;
 const legacy=own===undefined?preferredTradingConnection(connections):null,saved=own!==undefined?own:Array.isArray(connections?.tradingAccounts)?connections.preferredTradingConnection:'',id=legacy?(connectionPreferenceKey(legacy)===key?legacy.id:''):typeof saved==='string'?saved:'';
 if(!id)return {key,connectionId:'',record:null,state:'none',code:null};
 const record=records.find(r=>r.id===id);
 if(!record)return {key,connectionId:id,record:null,state:'invalid',code:'connection-missing'};
 if(connectionPreferenceKey(record)!==key)return {key,connectionId:id,record:null,state:'invalid',code:'connection-market'};
 return {key,connectionId:id,record,state:'valid',code:null};
}

export function accessTicketError(access,ticket){
 if(!access.ready)return access.code;
 return ticket.accountId!==access.accountId||ticket.scopeGeneration!==access.scopeGeneration||ticket.accessRevision!==access.revision||(ticket.connectionId||access.connectionId)&&ticket.connectionId!==access.connectionId?'review-again':null;
}

export const ACCESS_COPY={
 'local-service-offline':['本机模拟服务未连接','Local simulator offline','仅显示上次记录，不能确认保护正在运行。请恢复本机服务。','Showing last records. Active protection is not confirmed. Restore the local service.','retry-read','重新读取','Read again'],
 'local-result-pending':['原操作结果待确认','Original result unresolved','请查询原请求；确认前不会重复提交。','Check the original request. No duplicate will be submitted.','retry-read','查询原请求','Check original request'],
 'local-receipt-conflict':['成交记录待核对','Fill records need review','成交回执存在矛盾，已暂停新增交易；重新读取不会解除限制。','Fill receipts conflict. New trades are paused; refreshing does not clear the restriction.','retry-read','更新状态','Refresh status'],
 'local-risk-paused':['本机模拟已暂停新增','New local risk paused','仅本机隔离模拟；核对持仓与保护后再允许新增。','Isolated local simulation only. Review positions and protection before allowing new risk.','local-resume','允许新增模拟交易','Allow new simulated trades'],
 'local-price-wait':['等待有效模拟报价','Waiting for valid simulated quotes','服务在线，报价尚未确认；新增交易已阻止，保护等待有效报价。','The service is online, but quotes are not confirmed. New trades are blocked; protection awaits valid quotes.','retry-read','更新状态','Refresh status'],
 'exchange-read':['只读已核对','Read access checked','可以查看这个币安现货账户，不能提交新交易。','This Binance spot account can be viewed. No new order can be submitted.','',''],
 'exchange-trade-held':['交易权限已核对','Trade access checked','币安现货交易权限已核对。这一步不发单。','Binance spot trade access is checked. This step does not send an order.','',''],
 'exchange-denied':['权限不合要求','Permission not accepted','这把密钥带有提现或划转权限，已拒绝。请关掉后再检查。','This key includes withdrawal or transfer permission and was rejected. Turn that permission off, then check again.','connections','重新检查接入','Check connection again'],
 'exchange-region':['服务器地区被币安拒绝','Binance rejected this server region','这台服务器在美国，币安拒绝了账户检查。密钥没有用来下单。','This server is in the United States, so Binance refused the account check. The key was not used to place an order.','',''],
 'exchange-offline':['币安检查失败','Binance check failed','连接记录还在，草稿保留。可以再次检查。','The connection remains and the draft is unchanged. Check it again.','connections','重新检查接入','Check connection again'],
 'connection-missing':['原接入不可用','Original connection unavailable','请重新选择这份草稿使用的接入，不会借用其它账户。','Choose a connection for this draft. Another account will not be used.','connections','选择交易接入','Choose connection'],
 'connection-unchecked':['接入尚未检查','Connection needs checking','配置已保存，请检查当前权限后再继续。','Configuration is saved. Check current access before continuing.','connections','检查接入','Check connection'],
 'connection-market':['接入与产品不一致','Connection product mismatch','请选择与这份方案的平台、产品和网络一致的接入。','Choose a connection matching this plan’s venue, product and network.','connections','选择对应接入','Choose matching connection'],
 'connection-expired':['接入检查已失效','Connection check expired','新的交易已阻止，原有运行和委托仍可查询。','New trades are blocked. Existing runs and orders remain available to inspect.','connections','重新检查接入','Check connection again'],
 'wallet-held':['已连接登录钱包','Signed-in wallet connected','这是当前登录的 BSC 钱包。连接不授权交易，这一步不发送链上交易。','This is the signed-in BSC wallet. Connecting does not authorize a trade, and this step does not send one.','','',''],
 'wallet-authority':['钱包尚未授权交易','Wallet trading permission missing','钱包连接与交易授权不同，请检查本次签名范围。','Connecting a wallet does not grant trading access. Review the signature scope for this trade.','connections','检查钱包授权','Review wallet access'],
 'observe-ready':['只提醒，不下单','Watching without trading','可以启动信号提醒，尚未开启交易权限。','Signal alerts are available. Trading access remains disabled.','',''],
 ready:['可以模拟交易','Ready to simulate','账户与交易权限已就绪。','Account and trading access are ready.','',''],
 'other-account':['当前账户未接入','Account not connected','这里没有可用账本，也不会使用其它账户下单。','No ledger is available here. Orders will not use another account.','use-demo','切回模拟账户','Use demo account'],
 reading:['正在恢复账户数据','Restoring account data','数据恢复后再操作，不会重发订单。','Wait for recovery. Orders will not be resubmitted.','',''],
 'view-offline':['数据更新已断开','Updates disconnected','显示上次确认数据。已提交订单与已有保护仍按原计划处理。','Showing last confirmed data. Submitted orders and existing protection continue under the original plan.','retry-read','恢复数据更新','Restore updates'],
 'account-off':['模拟账户已停用','Demo account disabled','研究可以继续；启用账户后再设置交易。','Research can continue. Enable the account before setting up trades.','enable-account','启用模拟账户','Enable demo account'],
 'api-offline':['交易连接已断开','Trading connection disconnected','新订单已暂停，已有订单和持仓保留。','New orders are blocked. Existing orders and holdings are retained.','reconnect-api','重新连接模拟账户','Reconnect demo account'],
 permissions:['交易权限不足','Trading access missing','先检查模拟 API 权限，再继续交易。','Check demo API access before continuing.','check-permissions','检查交易权限','Check trading access'],
 'unsupported-route':['此接入尚不能执行策略','This connection cannot execute strategies','策略模拟使用统一账户，当前接入方案未适配这条交易路线。','Strategy simulation uses the unified account. This access plan does not support the route.','use-demo','使用统一模拟账户','Use unified demo account'],
 'read-only':['当前只能查看数据','View-only access','不会提交新交易。开启模拟交易后，仍需确认金额和保护。','No new orders can be submitted. Enable simulated trading, then review amounts and protection.','enable-trade','开启模拟交易权限','Enable simulated trading'],
 'data-off':['研究数据已关闭','Research data disabled','启用数据后，才能继续检查新的交易。','Enable research data before checking a new trade.','data','设置研究数据','Set up research data'],
 'ai-off':['Agent 演示已关闭','Agent simulation disabled','开启后继续策略检查；已有持仓保留。','Enable it to continue strategy checks. Existing holdings are retained.','ai','设置 AI 模型','Set up AI models'],
 'wallet-offline':['模拟钱包未连接','Demo wallet disconnected','连接账户不等于授权交易；每笔交易单独确认。','Connecting an account does not authorize a trade. Review each trade separately.','connect-wallet','连接模拟钱包','Connect demo wallet'],
 'wallet-network':['钱包网络不一致','Wallet network mismatch','先切换到这笔交易使用的网络，再重新确认。','Switch to this trade’s network, then review again.','switch-wallet-network','切换模拟网络','Switch demo network'],
 'review-again':['交易条件已更新','Trade context changed','账户或接入状态变了。金额已保留，请刷新报价并重新确认。','Account or access changed. Amounts are retained. Refresh the quote and review again.','refresh-quote','刷新报价并重新确认','Refresh quote & review']
};

export const accessMessage=access=>ACCESS_COPY[access.code]?.[2]||ACCESS_COPY['review-again'][2];
