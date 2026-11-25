// R3 PRIVATE paper-draft DTOs. These checks do not authenticate an owner, verify
// the stored report, compile a strategy or authorize any execution.
const INPUT='PRIVATE_REQUEST_INVALID',OUTPUT='PRIVATE_UI_PROTOCOL';
const MAX_MILLIS=253402300799999,MAX_SECONDS=253402300799;
const SECRET=/\bBearer\s+[A-Za-z0-9._-]{16,}|\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{16,}|(?:https?|postgres(?:ql)?):\/\/[^\s/@:]+:[^\s/@]+@|\b0x[0-9a-fA-F]{64}\b/;
const FIELD_KEYS=['name','strategy','planVariant','market','environment','mode','amount','cap','researchBudget','botParameters','protection','executionRoute'];
const GRID_KEYS=['lower','upper','count','spacing','triggerPrice','takeProfitPrice','stopLossPrice'];
const BASKET_KEYS=['deviationPct','sizeMultiplier','maxEntries','takeProfitPct','stopLossPct','triggerPrice'];
const CHANGE_GROUPS=['source',...FIELD_KEYS.map(key=>'fields.'+key)];
const fail=code=>{throw Object.assign(Error(code),{code,status:code===INPUT?400:502});};
const check=(value,code)=>{if(!value)fail(code);};
const integer=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const millis=value=>integer(value,MAX_MILLIS);
const number=(value,min,max,exclusiveMin=false,exclusiveMax=false)=>Number.isFinite(value)&&(exclusiveMin?value>min:value>=min)&&(exclusiveMax?value<max:value<=max);
const text=(value,max)=>typeof value==='string'&&value.length>0&&[...value].length<=max&&!/[\u0000-\u001f\u007f]/.test(value)&&!SECRET.test(value)&&(!value.isWellFormed||value.isWellFormed());
const id=(value,max=128)=>typeof value==='string'&&new RegExp(`^[A-Za-z0-9:_-]{1,${max}}$`).test(value)&&!SECRET.test(value);
const requestId=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{8,96}$/.test(value)&&!SECRET.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function exact(value,keys,code){
 check(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,code);
 const descriptors=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(descriptors);
 check(own.length===keys.length&&own.every(key=>typeof key==='string'&&keys.includes(key)&&Object.hasOwn(descriptors[key],'value')&&descriptors[key].enumerable),code);
}
function list(value,max,code){
 check(Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype&&value.length<=max,code);
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
 check(keys.length===value.length+1&&keys.every(key=>key==='length'||typeof key==='string'&&/^(?:0|[1-9]\d*)$/.test(key)&&Number(key)<value.length&&Object.hasOwn(descriptors[key],'value')&&descriptors[key].enumerable),code);
}
function scope(value,ownerRef,code){check(id(value)&&(ownerRef===undefined||value===ownerRef),code);}
function result(value,limit,code){check(new TextEncoder().encode(JSON.stringify(value)).byteLength<=limit,code);return structuredClone(value);}
// Compare only already validated JSON data. JSONB key order is not a change;
// this comparison does not serialize, hash or issue a proposal token.
function same(left,right){
 if(left===right)return true;
 if(left===null||right===null||typeof left!=='object'||typeof right!=='object'||Array.isArray(left)!==Array.isArray(right))return false;
 if(Array.isArray(left))return left.length===right.length&&left.every((value,index)=>same(value,right[index]));
 const keys=Object.keys(left);return keys.length===Object.keys(right).length&&keys.every(key=>Object.hasOwn(right,key)&&same(left[key],right[key]));
}
const nullable=(value,valid)=>value===null||valid(value);
const price=value=>number(value,0,1e12,true);

// Match the Core Decimal(str(number)) capacity comparisons, including the 0.1%
// paper fee. Binary float rounding must not move an exact cap boundary.
function decimal(value){
 const [mantissa,exponent='0']=String(value).toLowerCase().split('e'),[whole,fraction='']=mantissa.split('.'),scale=fraction.length-Number(exponent);
 return {n:BigInt(whole+fraction)*10n**BigInt(Math.max(0,-scale)),scale:Math.max(0,scale)};
}
const multiply=(a,b)=>({n:a.n*b.n,scale:a.scale+b.scale});
function add(a,b){const scale=Math.max(a.scale,b.scale);return {n:a.n*10n**BigInt(scale-a.scale)+b.n*10n**BigInt(scale-b.scale),scale};}
function greater(a,b){const scale=Math.max(a.scale,b.scale);return a.n*10n**BigInt(scale-a.scale)>b.n*10n**BigInt(scale-b.scale);}
function capacity(value,code){
 if(value.amount===null||value.cap===null)return;
 const amount=decimal(value.amount),params=value.botParameters,fee=decimal(1.001);let required=amount;
 if(value.strategy==='S01'&&params!==null&&params.count!==null)required=multiply(multiply(amount,decimal(params.count)),fee);
 else if(value.strategy==='S02'&&params!==null&&params.maxEntries!==null&&params.sizeMultiplier!==null){
  required=decimal(0);let size=amount;const multiplier=decimal(params.sizeMultiplier);
  for(let index=0;index<params.maxEntries;index++){required=add(required,multiply(size,fee));size=multiply(size,multiplier);}
 }
 check(!greater(required,decimal(value.cap)),code);
}
function botParameters(value,strategy,code){
 if(value===null)return;
 exact(value,strategy==='S01'?GRID_KEYS:BASKET_KEYS,code);
 if(strategy==='S01'){
  check(['lower','upper','triggerPrice','takeProfitPrice','stopLossPrice'].every(key=>nullable(value[key],price))&&nullable(value.count,item=>integer(item,100)&&item>=2)&&nullable(value.spacing,item=>['arithmetic','geometric'].includes(item)),code);
  check(!(value.lower!==null&&value.upper!==null&&value.upper<=value.lower||value.lower!==null&&value.stopLossPrice!==null&&value.stopLossPrice>=value.lower||value.upper!==null&&value.takeProfitPrice!==null&&value.takeProfitPrice<=value.upper||value.triggerPrice!==null&&(value.lower!==null&&value.triggerPrice<value.lower||value.upper!==null&&value.triggerPrice>value.upper)),code);
 }else check(nullable(value.deviationPct,item=>number(item,0,100,true,true))&&nullable(value.sizeMultiplier,item=>number(item,1,10))&&nullable(value.maxEntries,item=>integer(item,3)&&item>=1)&&nullable(value.takeProfitPct,item=>number(item,0,1000,true))&&nullable(value.stopLossPct,item=>number(item,0,100,true,true))&&nullable(value.triggerPrice,price),code);
}
function protection(value,code){
 if(value===null)return;
 check(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,code);
 const descriptor=Object.getOwnPropertyDescriptor(value,'version');check(descriptor&&Object.hasOwn(descriptor,'value'),code);
 if(descriptor.value==='strategy-original'){exact(value,['id','version'],code);check(value.id==='original',code);return;}
 const parameterized=descriptor.value==='astarter-research-v0.1/sim-3';
 exact(value,['id','version','mode',...(parameterized?['parameters']:[])],code);
 check(value.id==='astarter'&&['astarter-research-v0.1/sim-2','astarter-research-v0.1/sim-3'].includes(value.version)&&['normal','conservative'].includes(value.mode),code);
 if(parameterized){const p=value.parameters;exact(p,['episode','notional','daily','epoch','soft','hard'],code);check(Object.entries({episode:.0025,notional:.1,daily:.02,epoch:.05,soft:.03,hard:.08}).every(([key,max])=>number(p[key],0,max,true))&&p.soft<p.hard,code);}
}
function route(value,code){
 if(value===null)return;
 exact(value,['profileId','venueId','accountId','connectionId','chainId'],code);
 check(value.profileId==='cex-spot'&&value.venueId==='binance'&&value.accountId==='SIM-01'&&value.chainId===''&&typeof value.connectionId==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,79}$/.test(value.connectionId)&&!SECRET.test(value.connectionId),code);
}
function fields(value,code){
 exact(value,FIELD_KEYS,code);
 check(text(value.name,120)&&['S01','S02'].includes(value.strategy)&&value.planVariant===value.strategy+'-SIM'&&['BTC/USDT','ETH/USDT','SOL/USDT'].includes(value.market)&&value.environment==='DEMO'&&value.mode==='auto'&&nullable(value.amount,item=>number(item,10,1000))&&nullable(value.cap,item=>number(item,10,3000))&&nullable(value.researchBudget,item=>integer(item,10000)),code);
 botParameters(value.botParameters,value.strategy,code);protection(value.protection,code);route(value.executionRoute,code);capacity(value,code);
}
function source(value,code){
 exact(value,['kind','sourceRequestId','requestFingerprint','reportRevision','evidenceRevision','symbol','evidenceId','methodVersion','createdAt','validUntil','sourceClock'],code);
 check(value.kind==='private-research-request'&&requestId(value.sourceRequestId)&&digest(value.requestFingerprint)&&digest(value.reportRevision)&&digest(value.evidenceRevision)&&['BTC','ETH','SOL'].includes(value.symbol)&&typeof value.evidenceId==='string'&&/^market-[a-f0-9]{32}$/.test(value.evidenceId)&&value.methodVersion==='closed-market-research-v1'&&millis(value.createdAt)&&millis(value.validUntil)&&value.createdAt<value.validUntil,code);
 const clock=value.sourceClock;exact(clock,['unit','sampleAt','closedAt','validUntil'],code);
 check(clock.unit==='seconds'&&['sampleAt','closedAt','validUntil'].every(key=>integer(clock[key],MAX_SECONDS))&&clock.sampleAt%86400===0&&clock.closedAt===clock.sampleAt+86400&&clock.validUntil===clock.closedAt+86400&&clock.closedAt*1000<=value.createdAt&&value.validUntil<=clock.validUntil*1000,code);
}
function missingFields(value){
 const missing=FIELD_KEYS.filter(key=>value[key]===null),params=value.botParameters;
 if(params!==null){const required=value.strategy==='S01'?['lower','upper','count','spacing']:['deviationPct','sizeMultiplier','maxEntries','takeProfitPct','stopLossPct'];if(value.strategy==='S01'&&value.protection?.id==='astarter')required.push('stopLossPrice');for(const key of required)if(params[key]===null)missing.push('botParameters.'+key);}
 return missing.sort();
}
function content(value,code){
 exact(value,['catalogVersion','templateVersion','parameterOrigin','source','fields','missingFields','executionAuthority'],code);
 check(value.catalogVersion==='private-paper-draft-v1'&&value.parameterOrigin==='user-confirmed'&&value.executionAuthority==='NONE',code);
 fields(value.fields,code);source(value.source,code);list(value.missingFields,24,code);
 check(value.templateVersion===value.fields.planVariant+'@paper-v1'&&value.source.symbol+'/USDT'===value.fields.market&&same(value.missingFields,missingFields(value.fields)),code);
}
function input(value,adopt){
 exact(value,['draftId','sourceRequestId','fields',...(adopt?['requestId','expectedRevision','workspaceRevision','proposalRevision']:[])],INPUT);
 check(id(value.draftId,96)&&requestId(value.sourceRequestId),INPUT);fields(value.fields,INPUT);
 if(adopt)check(requestId(value.requestId)&&integer(value.expectedRevision)&&integer(value.workspaceRevision)&&digest(value.proposalRevision),INPUT);
 return result(value,16384,INPUT);
}
export const validatePrivateDraftPreviewInput=value=>input(value,false);
export const validatePrivateDraftAdoptInput=value=>input(value,true);
export function validatePrivateDraftDocument(value,ownerRef){
 exact(value,['schema','scope','draftId','revision','savedAt','content'],OUTPUT);
 check(value.schema==='private-strategy-draft-v1'&&id(value.draftId,96)&&integer(value.revision)&&value.revision>=1&&millis(value.savedAt),OUTPUT);scope(value.scope,ownerRef,OUTPUT);content(value.content,OUTPUT);
 check(value.content.source.createdAt<=value.savedAt&&value.savedAt<value.content.source.validUntil,OUTPUT);
 return result(value,65536,OUTPUT);
}
export function validatePrivateDraftPreview(value,ownerRef){
 exact(value,['schema','scope','draftId','expectedRevision','workspaceRevision','proposalRevision','listed','current','proposal','changedFields'],OUTPUT);
 check(value.schema==='private-draft-preview-v1'&&id(value.draftId,96)&&integer(value.expectedRevision)&&integer(value.workspaceRevision)&&digest(value.proposalRevision)&&typeof value.listed==='boolean',OUTPUT);scope(value.scope,ownerRef,OUTPUT);content(value.proposal,OUTPUT);
 if(value.current===null)check(value.expectedRevision===0,OUTPUT);
 else {validatePrivateDraftDocument(value.current,value.scope);check(value.current.draftId===value.draftId&&value.current.revision===value.expectedRevision,OUTPUT);}
 list(value.changedFields,13,OUTPUT);
 const changed=value.current===null?CHANGE_GROUPS:CHANGE_GROUPS.filter(group=>group==='source'?!same(value.current.content.source,value.proposal.source):!same(value.current.content.fields[group.slice(7)],value.proposal.fields[group.slice(7)]));
 check(same(value.changedFields,changed),OUTPUT);
 return result(value,65536,OUTPUT);
}
export function validatePrivateDraftCommandResult(value,originalRequestId,ownerRef){
 exact(value,['schema','scope','request','draft'],OUTPUT);check(value.schema==='private-draft-command-v1'&&requestId(originalRequestId),OUTPUT);scope(value.scope,ownerRef,OUTPUT);
 const receipt=value.request;exact(receipt,['requestId','draftId','status','expectedRevision','revision','workspaceBaseRevision','workspaceRevision','appliedAt'],OUTPUT);
 check(receipt.requestId===originalRequestId&&requestId(receipt.requestId)&&id(receipt.draftId,96)&&receipt.status==='applied'&&['expectedRevision','revision','workspaceBaseRevision','workspaceRevision'].every(key=>integer(receipt[key]))&&millis(receipt.appliedAt),OUTPUT);
 validatePrivateDraftDocument(value.draft,value.scope);
 check(receipt.draftId===value.draft.draftId&&receipt.revision===value.draft.revision&&receipt.expectedRevision+1===receipt.revision&&receipt.appliedAt===value.draft.savedAt&&receipt.workspaceBaseRevision<=receipt.workspaceRevision&&receipt.workspaceRevision<=receipt.workspaceBaseRevision+1,OUTPUT);
 return result(value,65536,OUTPUT);
}
