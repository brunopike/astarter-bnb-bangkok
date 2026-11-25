import {DAY_MS,validateTerms} from './wealth-fees.mjs';
export const STRATEGY_ACCOUNT_KEY='astarter.wealth.managed-paper.v2';
export const ASSET_SPECS=[
 {
  "id": "usdc",
  "symbol": "USDC",
  "icon": "USDC",
  "decimals": 6,
  "demoUnits": "10000000000"
 },
 {
  "id": "usdt",
  "symbol": "USDT",
  "icon": "USDT",
  "decimals": 6,
  "demoUnits": "10000000000"
 },
 {
  "id": "weth",
  "symbol": "WETH",
  "icon": "ETH",
  "decimals": 18,
  "demoUnits": "10000000000000000000"
 },
 {
  "id": "wbtc",
  "symbol": "WBTC",
  "icon": "BTC",
  "decimals": 8,
  "demoUnits": "25000000"
 }
];
const MAX_UNITS=(1n<<256n)-1n;

function fail(code){throw new Error(code);}

function id(value){return typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);}

function textValue(value){return typeof value==='string'&&value.trim().length>0&&value.length<=300;}

function bilingual(value){return Array.isArray(value)&&value.length===2&&value.every(textValue);}

function unsigned(value){return typeof value==='string'&&/^(0|[1-9]\d{0,77})$/.test(value)&&BigInt(value)<=MAX_UNITS;}

function validTime(value){return Number.isSafeInteger(value)&&value>=0;}

function address(value){return value===null||typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value)&&!/^0x0{40}$/i.test(value);}

function feeSettings(value,allowLegacy=false){return !!value&&id(value.version)&&value.managementRate===.02&&value.subscriptionRate===0&&Number.isFinite(value.performanceRate)&&value.performanceRate>=0&&value.performanceRate<=1&&Math.abs(value.performanceRate*10000-Math.round(value.performanceRate*10000))<1e-8&&(value.crystallisation==='annual-maturity-and-redemption'||allowLegacy&&value.crystallisation==='monthly-and-redemption')&&value.managementBasis==='daily-nav-act365'&&(allowLegacy||value.managementSettlement==='monthly'&&value.recipients?.management==='platform'&&value.recipients?.performance==='platform'&&['platform','vault'].includes(value.recipients?.earlyRedemption));}

export function parseStrategyAmount(value,decimals){
 if(typeof value!=='string'||value.length>100||!Number.isInteger(decimals)||decimals<0||decimals>18)fail('AMOUNT');
 const match=/^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value.trim());
 if(!match||match[2]?.length>decimals)fail('AMOUNT');
 const units=BigInt(match[1])*10n**BigInt(decimals)+BigInt((match[2]||'').padEnd(decimals,'0')||'0');
 if(units<=0n||units>MAX_UNITS)fail('AMOUNT');return units.toString();
}

export function formatStrategyUnits(value,decimals,group=true){
 if(!unsigned(value)||!Number.isInteger(decimals)||decimals<0||decimals>18)fail('AMOUNT');
 const digits=value.padStart(decimals+1,'0'),whole=decimals?digits.slice(0,-decimals):digits,fraction=decimals?digits.slice(-decimals).replace(/0+$/,''):'';
 return (group?whole.replace(/\B(?=(\d{3})+(?!\d))/g,','):whole)+(fraction?'.'+fraction:'');
}

export function validateStrategyConfig(config){
 // Preserve prior local draft contracts for recovery without upgrading their stored fee terms.
 const allowLegacy=config?.status==='draft'&&config?.version==='draft-20261112.3';
 if(config?.schemaVersion!==2||!id(config.id)||!textValue(config.version)||!['draft','published','paused'].includes(config.status)||typeof config.liveEnabled!=='boolean'||config.chain?.id!==1||config.chain.name!=='Ethereum')fail('CONFIG');
 if(!Array.isArray(config.assets)||config.assets.length!==ASSET_SPECS.length||!Array.isArray(config.products)||!config.products.length||config.products.length>20||!Array.isArray(config.profiles)||config.profiles.length!==4)fail('CONFIG');
 for(const rows of [config.assets,config.products,config.profiles])if(rows.some(row=>!id(row?.id))||new Set(rows.map(row=>row.id)).size!==rows.length)fail('CONFIG');
 for(const asset of config.assets){
  const spec=ASSET_SPECS.find(row=>row.id===asset.id);
  if(!spec||asset.symbol!==spec.symbol||asset.decimals!==spec.decimals||asset.chainId!==1||!bilingual(asset.name)||!address(asset.tokenAddress)||!unsigned(asset.minimumUnits)||!unsigned(asset.maximumUnits)||BigInt(asset.minimumUnits)<=0n||BigInt(asset.maximumUnits)<BigInt(asset.minimumUnits))fail('CONFIG');
 }
 for(const product of config.products)if(!bilingual(product.name)||!['lending','curated','term','liquidity','staking','savings','reserve'].includes(product.kind)||!Array.isArray(product.assetIds)||!product.assetIds.length||new Set(product.assetIds).size!==product.assetIds.length||product.assetIds.some(key=>!config.assets.some(asset=>asset.id===key)))fail('CONFIG');
 if(config.profiles.some(row=>!['growth','balanced','steady','defensive'].includes(row.id))||!config.profiles.some(row=>row.id===config.defaultProfileId))fail('CONFIG');
 const risks={growth:'high',balanced:'medium',steady:'low',defensive:'defensive'};
 for(const profile of config.profiles){
  const guard=profile.guards;
  try{validateTerms(profile.terms,{allowLegacy});}catch{fail('CONFIG');}
  if(profile.risk!==risks[profile.id]||profile.principalGuaranteed!==false||!bilingual(profile.name)||!bilingual(profile.goal)||!bilingual(profile.riskNote)||!feeSettings(profile.fees,allowLegacy)||!Array.isArray(profile.assetIds)||!profile.assetIds.length||new Set(profile.assetIds).size!==profile.assetIds.length||!profile.assetIds.includes(profile.defaultAssetId)||profile.assetIds.some(key=>!config.assets.some(asset=>asset.id===key)))fail('CONFIG');
  if(!guard||!Number.isInteger(guard.reserveBps)||guard.reserveBps<0||guard.reserveBps>10000||!Number.isInteger(guard.maxProductBps)||guard.maxProductBps<=0||guard.maxProductBps>10000||guard.allowLeverage!==false||guard.allowCrossChain!==false||!Number.isInteger(guard.switchNetGainBps)||guard.switchNetGainBps<0||guard.switchNetGainBps>10000)fail('CONFIG');
  if(!Array.isArray(profile.rules)||profile.rules.length!==4||profile.rules.some(rule=>!bilingual(rule.name)||!bilingual(rule.description))||!profile.allocations||Object.keys(profile.allocations).length!==profile.assetIds.length)fail('CONFIG');
  for(const assetId of profile.assetIds){
   if(profile.id!=='growth'&&!['usdc','usdt'].includes(assetId))fail('CONFIG');
   const rows=profile.allocations[assetId];if(!Array.isArray(rows)||rows.length<2||rows.length>6||new Set(rows.map(row=>row.productId)).size!==rows.length)fail('CONFIG');
   let total=0,reserve=0;
   for(const row of rows){
    const product=config.products.find(item=>item.id===row.productId);
    if(!product||!product.assetIds.includes(assetId)||!Number.isInteger(row.weightBps)||row.weightBps<=0||row.weightBps>10000)fail('CONFIG');
    if(product.kind==='reserve')reserve+=row.weightBps;else if(row.weightBps>guard.maxProductBps)fail('CONFIG');
    if(profile.id==='defensive'&&(!['usdc','usdt'].includes(assetId)||!['lending','savings','reserve'].includes(product.kind)))fail('CONFIG');
    total+=row.weightBps;
   }
   if(total!==10000||reserve<guard.reserveBps)fail('CONFIG');
  }
 }
 if(!config.vault||!address(config.vault.address)||!address(config.vault.spender))fail('CONFIG');
 const referral=config.referral;if(!referral||!id(referral.version)||referral.status!=='proposal'||referral.levels!==1||!Number.isInteger(referral.rateBps)||referral.rateBps<0||referral.rateBps>10000||referral.basis!=='collected-net-platform-fees'||referral.payout!=='monthly'||JSON.stringify(referral.eligibleKinds)!==JSON.stringify(['management','performance','early-redemption']))fail('CONFIG');
 return config;
}

export function selectedStrategy(config,profileId,assetId){
 validateStrategyConfig(config);const profile=config.profiles.find(row=>row.id===profileId),asset=config.assets.find(row=>row.id===assetId);
 if(!profile||!asset||!profile.assetIds.includes(assetId))fail('SELECTION');
 return {profile,asset};
}

export function strategyFundingGate(config,profileId,assetId){
 const {asset}=selectedStrategy(config,profileId,assetId);
 if(config.status!=='published')return 'CONFIG_NOT_PUBLISHED';
 if(!config.liveEnabled)return 'FUNDING_DISABLED';
 if(!asset.tokenAddress||!config.vault.address||config.vault.spender!==config.vault.address)return 'VAULT_NOT_READY';
 // shortcut: no chain adapter or receipt verifier exists; publishing metadata must never enable transfers.
 return 'ADAPTER_UNAVAILABLE';
}

export function buildAllocationPlan(config,profileId,assetId,amount){
 const {profile,asset}=selectedStrategy(config,profileId,assetId),amountUnits=parseStrategyAmount(amount,asset.decimals);
 if(BigInt(amountUnits)<BigInt(asset.minimumUnits))fail('MINIMUM');
 if(BigInt(amountUnits)>BigInt(asset.maximumUnits))fail('LIMIT');
 let remaining=BigInt(amountUnits);
 // Configured targets are a planning input, not proof of live optimisation or execution.
 const allocations=profile.allocations[assetId].map((row,index,rows)=>{
  const units=index===rows.length-1?remaining:BigInt(amountUnits)*BigInt(row.weightBps)/10000n;remaining-=units;
  return {...row,units:units.toString()};
 });
 return {profileId,assetId,amountUnits,configVersion:config.version,feeVersion:profile.fees.version,allocations};
}

export function strategyBalance(state,profileId,assetId){
 if(!ASSET_SPECS.some(row=>row.id===assetId)||!['growth','balanced','steady','defensive'].includes(profileId))fail('SELECTION');
 return {cashUnits:state.wallet[assetId],pendingUnits:state.intents.filter(row=>row.profileId===profileId&&row.assetId===assetId&&row.status==='funded').reduce((sum,row)=>sum+BigInt(row.remainingUnits),0n).toString(),queuedUnits:state.events.filter(row=>row.profileId===profileId&&row.assetId===assetId&&row.kind==='withdraw'&&row.status==='queued').reduce((sum,row)=>sum+BigInt(row.amountUnits),0n).toString()};
}

function validateState(state){
 if(!state||state.version!==2||!Number.isSafeInteger(state.revision)||state.revision<0||!state.wallet||Object.keys(state.wallet).sort().join(',')!==ASSET_SPECS.map(row=>row.id).sort().join(',')||!Array.isArray(state.intents)||!Array.isArray(state.events)||state.revision<state.intents.length+state.events.length)fail('STORAGE');
 const intentMap=new Map(),funded=new Map(),withdrawn=new Map(),ids=new Set(),requests=new Set();
 for(const intent of state.intents){
  if(!intent||!textValue(intent.id)||ids.has(intent.id)||!['authorized','funded'].includes(intent.status)||!ASSET_SPECS.some(row=>row.id===intent.assetId)||!['growth','balanced','steady','defensive'].includes(intent.profileId)||!unsigned(intent.amountUnits)||BigInt(intent.amountUnits)<=0n||!unsigned(intent.remainingUnits)||BigInt(intent.remainingUnits)>BigInt(intent.amountUnits)||!textValue(intent.configVersion)||!feeSettings(intent.fees,intent.configVersion==='draft-20261112.3')||typeof intent.fingerprint!=='string'||!intent.fingerprint.length||intent.fingerprint.length>100000||!validTime(intent.createdAt)||intent.expiresAt!==intent.createdAt+600000||intent.highWaterMark!==null||intent.nav!==null)fail('STORAGE');
  try{validateTerms(intent.terms,{allowLegacy:intent.configVersion==='draft-20261112.3'});}catch{fail('STORAGE');}
  let bound;try{bound=JSON.parse(intent.fingerprint);}catch{fail('STORAGE');}
  const boundProfile=bound?.config?.profiles?.find(row=>row.id===intent.profileId);
  if(!boundProfile||bound.profileId!==intent.profileId||bound.assetId!==intent.assetId||bound.amountUnits!==intent.amountUnits||JSON.stringify(boundProfile.fees)!==JSON.stringify(intent.fees)||JSON.stringify(boundProfile.terms)!==JSON.stringify(intent.terms))fail('STORAGE');
  if(intent.status==='authorized'&&intent.remainingUnits!=='0')fail('STORAGE');
  ids.add(intent.id);intentMap.set(intent.id,intent);
 }
 for(const event of state.events){
  if(!event||!textValue(event.id)||ids.has(event.id)||!['fund','withdraw'].includes(event.kind)||!unsigned(event.amountUnits)||BigInt(event.amountUnits)<=0n||!validTime(event.at)||!ASSET_SPECS.some(row=>row.id===event.assetId)||!['growth','balanced','steady','defensive'].includes(event.profileId))fail('STORAGE');
  ids.add(event.id);
  if(event.kind==='fund'){
   const intent=intentMap.get(event.intentId);
   if(!intent||intent.status!=='funded'||intent.assetId!==event.assetId||intent.profileId!==event.profileId||intent.amountUnits!==event.amountUnits||funded.has(intent.id))fail('STORAGE');
   if(event.at<intent.createdAt||event.at>=intent.expiresAt)fail('STORAGE');funded.set(intent.id,event.at);
  }else{
   if(!textValue(event.requestId)||requests.has(event.requestId)||!['queued','settled'].includes(event.status)||event.settlementAt!==event.at+2*DAY_MS||(event.status==='settled'?(!validTime(event.settledAt)||event.settledAt<event.settlementAt):event.settledAt!==null)||!Array.isArray(event.lots)||!event.lots.length||new Set(event.lots.map(row=>row.intentId)).size!==event.lots.length)fail('STORAGE');
   requests.add(event.requestId);let total=0n;
   for(const lot of event.lots){
    const intent=intentMap.get(lot.intentId);
    if(!intent||intent.status!=='funded'||!funded.has(intent.id)||event.at<funded.get(intent.id)||intent.assetId!==event.assetId||intent.profileId!==event.profileId||!unsigned(lot.units)||BigInt(lot.units)<=0n)fail('STORAGE');
    total+=BigInt(lot.units);withdrawn.set(intent.id,(withdrawn.get(intent.id)||0n)+BigInt(lot.units));
   }
   if(total!==BigInt(event.amountUnits)||event.feesUnits!=='0')fail('STORAGE');
  }
 }
 for(const intent of state.intents)if(intent.status==='funded'&&(!funded.has(intent.id)||BigInt(intent.amountUnits)-(withdrawn.get(intent.id)||0n)!==BigInt(intent.remainingUnits)))fail('STORAGE');
 for(const spec of ASSET_SPECS){
  if(!unsigned(state.wallet[spec.id]))fail('STORAGE');
  const remaining=state.intents.filter(row=>row.assetId===spec.id).reduce((sum,row)=>sum+BigInt(row.remainingUnits),0n);
  const queued=state.events.filter(row=>row.kind==='withdraw'&&row.assetId===spec.id&&row.status==='queued').reduce((sum,row)=>sum+BigInt(row.amountUnits),0n);
  if(BigInt(state.wallet[spec.id])+remaining+queued!==BigInt(spec.demoUnits))fail('STORAGE');
 }
 return state;
}

export function createStrategyWealthStore(storage){
 const initial=()=>({version:2,revision:0,wallet:Object.fromEntries(ASSET_SPECS.map(row=>[row.id,row.demoUnits])),intents:[],events:[]});
 function read(){const raw=storage.getItem(STRATEGY_ACCOUNT_KEY);if(raw===null)return initial();let state;try{state=JSON.parse(raw);}catch{fail('STORAGE');}return validateState(state);}
 function save(state){validateState(state);const raw=JSON.stringify(state);storage.setItem(STRATEGY_ACCOUNT_KEY,raw);if(storage.getItem(STRATEGY_ACCOUNT_KEY)!==raw)fail('STORAGE');return state;}
 function scope(config,profileId,assetId,amount){
  validateStrategyConfig(config);if(config.status==='paused')fail('PAUSED');const plan=buildAllocationPlan(config,profileId,assetId,amount),{profile,asset}=selectedStrategy(config,profileId,assetId);
  return {plan,profile,asset,fingerprint:JSON.stringify({config,profileId,assetId,amountUnits:plan.amountUnits})};
 }
 function available(state,context){
  const amount=BigInt(context.plan.amountUnits),assetId=context.asset.id;
  if(amount>BigInt(state.wallet[assetId]))fail('BALANCE');
  const pending=state.intents.filter(row=>row.assetId===assetId).reduce((sum,row)=>sum+BigInt(row.remainingUnits),0n)+state.events.filter(row=>row.kind==='withdraw'&&row.assetId===assetId&&row.status==='queued').reduce((sum,row)=>sum+BigInt(row.amountUnits),0n);
  if(pending+amount>BigInt(context.asset.maximumUnits))fail('LIMIT');
 }
 // shortcut: isolated local demo ledger; real funds need a wallet-scoped transactional service.
 return {read,authorize(config,profileId,assetId,amount,now=Date.now()){
  const context=scope(config,profileId,assetId,amount),state=read();if(!validTime(now))fail('TIME');available(state,context);
  const intent={id:'auth-'+(++state.revision),status:'authorized',profileId,assetId,amountUnits:context.plan.amountUnits,remainingUnits:'0',configVersion:config.version,fees:{...context.profile.fees},terms:{...context.profile.terms},fingerprint:context.fingerprint,createdAt:now,expiresAt:now+600000,highWaterMark:null,nav:null};
  state.intents.push(intent);save(state);return intent.id;
 },confirmFunding(intentId,config,profileId,assetId,amount,now=Date.now()){
  const context=scope(config,profileId,assetId,amount),state=read(),intent=state.intents.find(row=>row.id===intentId);
  if(!intent||intent.fingerprint!==context.fingerprint)fail('AUTH_CHANGED');
  if(intent.status==='funded')return state;
  if(!validTime(now)||now<intent.createdAt||now>=intent.expiresAt)fail('AUTH_EXPIRED');available(state,context);
  state.wallet[assetId]=(BigInt(state.wallet[assetId])-BigInt(intent.amountUnits)).toString();intent.status='funded';intent.remainingUnits=intent.amountUnits;
  state.events.push({id:'event-'+(++state.revision),kind:'fund',intentId,profileId,assetId,amountUnits:intent.amountUnits,at:now});return save(state);
 },withdraw(profileId,assetId,amount,requestId,now=Date.now()){
  const spec=ASSET_SPECS.find(row=>row.id===assetId);if(!spec||!['growth','balanced','steady','defensive'].includes(profileId))fail('SELECTION');
  const amountUnits=parseStrategyAmount(amount,spec.decimals),state=read();if(!textValue(requestId))fail('REQUEST');
  const previous=state.events.find(row=>row.kind==='withdraw'&&row.requestId===requestId);
  if(previous){if(previous.profileId!==profileId||previous.assetId!==assetId||previous.amountUnits!==amountUnits)fail('REQUEST');return state;}
  if(!validTime(now))fail('TIME');if(BigInt(amountUnits)>BigInt(strategyBalance(state,profileId,assetId).pendingUnits))fail('BALANCE');
  let left=BigInt(amountUnits);const lots=[];
  for(const intent of state.intents){
   if(intent.status!=='funded'||intent.profileId!==profileId||intent.assetId!==assetId||intent.remainingUnits==='0')continue;
   const fundedAt=state.events.find(row=>row.kind==='fund'&&row.intentId===intent.id).at;if(now<fundedAt)fail('TIME');
   const take=left<BigInt(intent.remainingUnits)?left:BigInt(intent.remainingUnits);
   intent.remainingUnits=(BigInt(intent.remainingUnits)-take).toString();left-=take;lots.push({intentId:intent.id,units:take.toString()});if(left===0n)break;
  }
  state.events.push({id:'event-'+(++state.revision),kind:'withdraw',requestId,profileId,assetId,amountUnits,lots,at:now,status:'queued',settlementAt:now+2*DAY_MS,settledAt:null,feesUnits:'0'});return save(state);
 },settle(requestId,now=Date.now()){
  const state=read(),event=state.events.find(row=>row.kind==='withdraw'&&row.requestId===requestId);if(!event)fail('REQUEST');if(event.status==='settled')return state;
  if(!validTime(now)||now<event.settlementAt)fail('SETTLEMENT_PENDING');
  event.status='settled';event.settledAt=now;state.wallet[event.assetId]=(BigInt(state.wallet[event.assetId])+BigInt(event.amountUnits)).toString();state.revision++;return save(state);
 }};
}

