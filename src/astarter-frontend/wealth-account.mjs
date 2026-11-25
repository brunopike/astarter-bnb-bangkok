import {parseWealthAmount} from './wealth-data.mjs';

export const WEALTH_ACCOUNT_KEY='astarter.wealth.managed-paper.v1';
const INITIAL_CASH=10_000_000_000;
const units=value=>Number.isSafeInteger(value)&&value>=0;
const fail=code=>{throw new Error(code);};
const named=value=>typeof value==='string'&&value.length>0&&value.length<=160;
const address=value=>typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value)&&!/^0x0{40}$/i.test(value);

export function validateWealthConfig(config){
 if(config?.schemaVersion!==1||!named(config.id)||!named(config.version)||!['draft','published','paused'].includes(config.status))fail('CONFIG');
 const asset=config.asset;
 if(asset?.symbol!=='USDC'||asset.decimals!==6||!Number.isSafeInteger(asset.chainId)||asset.chainId<=0||!named(asset.network))fail('CONFIG');
 if(!units(config.minimumUnits)||config.minimumUnits===0||!units(config.maximumUnits)||config.maximumUnits<config.minimumUnits)fail('CONFIG');
 if(!config.fees||!named(config.fees.version)||!['managementRate','performanceRate'].every(key=>Number.isFinite(config.fees[key])&&config.fees[key]>=0&&config.fees[key]<=1))fail('CONFIG');
 if(!Array.isArray(config.products)||!config.products.length||!Array.isArray(config.portfolios)||!config.portfolios.length||!Array.isArray(config.strategies)||!config.strategies.length)fail('CONFIG');
 for(const rows of [config.products,config.portfolios,config.strategies])if(rows.some(row=>!named(row?.id))||new Set(rows.map(row=>row.id)).size!==rows.length)fail('CONFIG');
 if(config.products.some(row=>!['lending','reserve'].includes(row.kind)||row.chainId!==asset.chainId||!Array.isArray(row.name)||row.name.length!==2||!row.name.every(named)))fail('CONFIG');
 const guards=config.guards;
 if(!guards||!Number.isInteger(guards.reserveBps)||guards.reserveBps<0||guards.reserveBps>10000||!Number.isInteger(guards.maxProductBps)||guards.maxProductBps<=0||guards.maxProductBps>10000||guards.allowLeverage!==false||guards.allowCrossChain!==false)fail('CONFIG');
 for(const portfolio of config.portfolios){
  if(!Array.isArray(portfolio.name)||portfolio.name.length!==2||!portfolio.name.every(named)||!Array.isArray(portfolio.allocations)||!portfolio.allocations.length)fail('CONFIG');
  const seen=new Set();let total=0,reserve=0;
  for(const row of portfolio.allocations){
   const product=config.products.find(product=>product.id===row.productId);
   if(!product||seen.has(row.productId)||!Number.isInteger(row.weightBps)||row.weightBps<=0||row.weightBps>10000)fail('CONFIG');
   if(product.kind!=='reserve'&&row.weightBps>guards.maxProductBps)fail('CONFIG');
   seen.add(row.productId);total+=row.weightBps;if(product.kind==='reserve')reserve+=row.weightBps;
  }
  if(total!==10000||reserve<guards.reserveBps)fail('CONFIG');
 }
 if(!config.portfolios.some(row=>row.id===config.activePortfolioId)||config.strategies.some(row=>!config.portfolios.some(portfolio=>portfolio.id===row.portfolioId)||!Array.isArray(row.name)||row.name.length!==2||!row.name.every(named)||!Array.isArray(row.description)||row.description.length!==2||!row.description.every(named)))fail('CONFIG');
 if(typeof config.liveEnabled!=='boolean'||!config.vault||!['address','spender'].every(key=>config.vault[key]===null||address(config.vault[key]))||!(asset.tokenAddress===null||address(asset.tokenAddress)))fail('CONFIG');
 return config;
}

export function liveFundingGate(config){
 validateWealthConfig(config);
 if(config.status!=='published')return 'CONFIG_NOT_PUBLISHED';
 if(!config.liveEnabled)return 'FUNDING_DISABLED';
 if(!address(config.asset.tokenAddress)||!address(config.vault.address)||config.vault.spender!==config.vault.address)return 'VAULT_NOT_READY';
 // shortcut: this candidate has no chain receipt verifier or funding adapter; never broadcast from it.
 return 'ADAPTER_UNAVAILABLE';
}

export function allocationPreview(config,amountUnits){
 validateWealthConfig(config);if(!units(amountUnits))fail('AMOUNT');
 const rows=config.portfolios.find(row=>row.id===config.activePortfolioId).allocations;
 let left=amountUnits;
 return rows.map((row,index)=>{const allocated=index===rows.length-1?left:Number(BigInt(amountUnits)*BigInt(row.weightBps)/10000n);left-=allocated;return {...row,units:allocated};});
}

function fundingScope(config,amount){
 validateWealthConfig(config);if(config.status==='paused')fail('PAUSED');
 const amountUnits=parseWealthAmount(amount);
 if(amountUnits<config.minimumUnits)fail('MINIMUM');if(amountUnits>config.maximumUnits)fail('LIMIT');
 return {amountUnits,fingerprint:JSON.stringify(config)};
}
const initial=()=>({version:1,revision:0,cashUnits:INITIAL_CASH,pendingUnits:0,intents:[],events:[]});
// shortcut: browser-local demo ledger; use a wallet-scoped transactional service before accepting real funds.
export function createManagedWealthStore(storage){
 function read(){
  const raw=storage.getItem(WEALTH_ACCOUNT_KEY);if(raw===null)return initial();
  let state;try{state=JSON.parse(raw);}catch{fail('STORAGE');}
  if(!state||state.version!==1||!units(state.revision)||!units(state.cashUnits)||!units(state.pendingUnits)||state.cashUnits+state.pendingUnits!==INITIAL_CASH||!Array.isArray(state.intents)||!Array.isArray(state.events))fail('STORAGE');
  const ids=new Set();let remaining=0;
  for(const intent of state.intents){
   if(!intent||!named(intent.id)||ids.has(intent.id)||!['authorized','funded'].includes(intent.status)||!units(intent.amountUnits)||intent.amountUnits===0||!units(intent.remainingUnits)||intent.remainingUnits>intent.amountUnits||!named(intent.configVersion)||typeof intent.fingerprint!=='string'||!Number.isFinite(intent.createdAt)||intent.createdAt<0||!Number.isFinite(intent.expiresAt)||intent.expiresAt<=intent.createdAt||intent.highWaterMark!==1)fail('STORAGE');
   if(intent.status==='authorized'&&intent.remainingUnits!==0)fail('STORAGE');
   ids.add(intent.id);remaining+=intent.remainingUnits;
  }
  if(remaining!==state.pendingUnits||state.events.some(event=>!event||!named(event.id)||!['fund','withdraw'].includes(event.kind)||!units(event.amountUnits)||event.amountUnits===0||!Number.isFinite(event.at)||event.at<0||!named(event.configVersion)||event.kind==='withdraw'&&!named(event.requestId)))fail('STORAGE');
  return state;
 }
 function save(state){const raw=JSON.stringify(state);storage.setItem(WEALTH_ACCOUNT_KEY,raw);if(storage.getItem(WEALTH_ACCOUNT_KEY)!==raw)fail('STORAGE');return state;}
 return {read,authorize(config,amount,now=Date.now()){
  const scope=fundingScope(config,amount),state=read();if(!Number.isFinite(now)||now<0)fail('TIME');
  if(scope.amountUnits>state.cashUnits)fail('BALANCE');if(scope.amountUnits+state.pendingUnits>config.maximumUnits)fail('LIMIT');
  const id='authorization-'+(++state.revision);
  state.intents.push({id,status:'authorized',...scope,remainingUnits:0,configVersion:config.version,createdAt:now,expiresAt:now+600000,highWaterMark:1});
  save(state);return id;
 },confirmFunding(id,config,amount,now=Date.now()){
  const scope=fundingScope(config,amount),state=read(),intent=state.intents.find(row=>row.id===id);
  if(!intent||intent.fingerprint!==scope.fingerprint||intent.amountUnits!==scope.amountUnits)fail('AUTH_CHANGED');
  if(intent.status==='funded')return state;
  if(!Number.isFinite(now)||now<intent.createdAt||now>=intent.expiresAt)fail('AUTH_EXPIRED');
  if(intent.amountUnits>state.cashUnits)fail('BALANCE');if(intent.amountUnits+state.pendingUnits>config.maximumUnits)fail('LIMIT');
  state.cashUnits-=intent.amountUnits;state.pendingUnits+=intent.amountUnits;intent.status='funded';intent.remainingUnits=intent.amountUnits;
  state.events.push({id:'event-'+(++state.revision),kind:'fund',amountUnits:intent.amountUnits,configVersion:intent.configVersion,at:now});
  return save(state);
 },withdraw(amount,requestId,now=Date.now()){
  const amountUnits=parseWealthAmount(amount),state=read();if(!named(requestId))fail('REQUEST');
  const previous=state.events.find(event=>event.requestId===requestId);if(previous){if(previous.kind!=='withdraw'||previous.amountUnits!==amountUnits)fail('REQUEST');return state;}
  if(!Number.isFinite(now)||now<0)fail('TIME');if(amountUnits>state.pendingUnits)fail('BALANCE');
  let left=amountUnits,version;
  for(const intent of state.intents){if(intent.status!=='funded'||!intent.remainingUnits)continue;const take=Math.min(left,intent.remainingUnits);intent.remainingUnits-=take;left-=take;version=intent.configVersion;if(!left)break;}
  state.pendingUnits-=amountUnits;state.cashUnits+=amountUnits;
  state.events.push({id:'event-'+(++state.revision),kind:'withdraw',requestId,amountUnits,configVersion:version,at:now});return save(state);
 }};
}
