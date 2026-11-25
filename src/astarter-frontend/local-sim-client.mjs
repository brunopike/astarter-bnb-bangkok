const copy=value=>structuredClone(value);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const failure=(code,unknown=false)=>Object.assign(Error(code),{code,unknown});
const validReceipt=(value,requestId,command)=>value?.requestId===requestId&&typeof value.ok==='boolean'&&['COMMITTED','NOT_ACCEPTED'].includes(value.requestStatus)&&(value.requestStatus!=='NOT_ACCEPTED'||value.ok===false)&&integer(value.revision)&&['create','action','prices','fixture-receipt','new-risk'].includes(value.command)&&(!command||value.command===command);
const canonical=value=>JSON.stringify(value,(_,item)=>item&&Object.getPrototypeOf(item)===Object.prototype?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);

export function localSimFixture(search){
 const value=new URLSearchParams(search).get('localSim');
 if(value===null)return null;
 if(!validId(value))throw failure('LOCAL_FIXTURE_INVALID');
 return value;
}

export function localSimStorage(storage,fixtureId){
 if(!validId(fixtureId))throw failure('LOCAL_FIXTURE_INVALID');
 const prefix='astarter.local-sim:'+fixtureId+':';
 return {getItem:key=>storage?.getItem(prefix+key)??null,setItem(key,value){if(!storage)throw failure('LOCAL_STORAGE_UNAVAILABLE');storage.setItem(prefix+key,value);if(storage.getItem(prefix+key)!==value)throw failure('LOCAL_STORAGE_UNAVAILABLE');},removeItem:key=>storage?.removeItem(prefix+key)};
}

export function validLocalSimSnapshot(value,fixtureId){
 const t=value?.trade,a=t?.accountSummary;
 return value?.schema==='AstarterLocalSim.v1'&&value.mode==='ISOLATED_LOCAL_SIMULATION'&&value.fixtureId===fixtureId&&integer(value.revision)&&integer(value.owner?.epoch)&&typeof value.owner.protectionAvailable==='boolean'&&value.capabilities?.realTrading===false&&value.capabilities.nativeAccepted===false&&value.capabilities.protectionScope==='LOCAL_PROCESS_ONLY'&&typeof value.recovery?.newRiskPaused==='boolean'&&typeof value.recovery.accountingKnown==='boolean'&&t&&[t.cash,t.totalFees,t.time].every(n=>Number.isFinite(n)&&n>=0)&&Array.isArray(t.orders)&&Array.isArray(t.events)&&Array.isArray(t.botBook?.runs)&&a?.fixtureId===fixtureId&&a.accountId==='SIM-01'&&a.environment==='DEMO'&&a.unit==='USDT'&&[a.cash,a.available,a.reserved,a.equity].every(n=>Number.isFinite(n)&&n>=0)&&a.available<=a.cash+1e-9&&t.botBook.runs.every(run=>run.environment==='DEMO'&&run.plan?.executionRoute?.accountId==='SIM-01'&&run.plan.executionRoute.connectionId==='local-fixture');
}

// This client only projects the service ledger. It never instantiates or advances a Book.
export class LocalSimClient{
 constructor({fixtureId,fetchImpl=globalThis.fetch.bind(globalThis),storage=null,onChange=()=>{}}){
  if(!validId(fixtureId))throw failure('LOCAL_FIXTURE_INVALID');
  this.fixtureId=fixtureId;this.fetch=fetchImpl;this.storage=storage;this.onChange=onChange;this.snapshot=null;this.state='OFFLINE';this.error='';this.pending=null;this.inflight=null;this.reading=null;this.revision=0;
  try{const value=JSON.parse(storage?.getItem('pending-command')||'null');if(value!==null){if(value.fixtureId!==fixtureId||!validId(value.requestId)||!integer(value.ownerEpoch)||!integer(value.expectedRevision)||!['create','action','prices','fixture-receipt','new-risk'].includes(value.command)||!value.payload||typeof value.payload!=='object')throw failure('LOCAL_PENDING_INVALID');this.pending=value;}}
  catch{this.pendingError='LOCAL_PENDING_INVALID';this.error=this.pendingError;}
 }
 changed(){this.revision++;this.onChange(this);}
 install(snapshot){
  if(!validLocalSimSnapshot(snapshot,this.fixtureId))throw failure('LOCAL_SNAPSHOT_INVALID');
  const previous=this.snapshot;
  if(previous&&(snapshot.owner.epoch<previous.owner.epoch||snapshot.owner.epoch===previous.owner.epoch&&(snapshot.revision<previous.revision||(snapshot.stateRevision??snapshot.revision)<(previous.stateRevision??previous.revision))))return false;
  this.snapshot=copy(snapshot);this.receivedAt=Date.now();this.state=snapshot.owner.state==='RUNNING'&&snapshot.owner.protectionAvailable?'LIVE':'OFFLINE';this.error=this.state==='LIVE'?'':'LOCAL_SERVICE_UNAVAILABLE';this.changed();return true;
 }
 async request(path,init={}){
  const response=await this.fetch('/api/local-sim'+path,{credentials:'same-origin',signal:AbortSignal.timeout(10000),...init});
  const body=await response.json();
  if(body?.snapshot)this.install(body.snapshot);
  return {response,body};
 }
 refresh(){
  if(this.reading)return this.reading;
  this.reading=(async()=>{try{const {response,body}=await this.request('/snapshot');if(!response.ok||body?.ok!==true||!body.snapshot)throw failure(body?.code||body?.error||'LOCAL_SERVICE_UNAVAILABLE');return this.snapshot;}
   catch(error){this.state='OFFLINE';this.error=error.code||'LOCAL_SERVICE_UNAVAILABLE';this.changed();return null;}
   finally{this.reading=null;}})();return this.reading;
 }
 retain(envelope){
  if(!this.storage)throw failure('LOCAL_STORAGE_UNAVAILABLE');
  const value=JSON.stringify(envelope);this.storage.setItem('pending-command',value);this.pending=copy(envelope);this.changed();
 }
 clear(){this.storage?.removeItem('pending-command');this.pending=null;this.changed();}
 async recover(requestId=this.pending?.requestId){
  if(!validId(requestId))throw failure('LOCAL_REQUEST_INVALID');
  try{
   const {response,body}=await this.request('/requests/'+encodeURIComponent(requestId));
   if(!response.ok||body?.ok!==true||!body.receipt)throw failure(body?.code||body?.error||'LOCAL_RESULT_UNKNOWN',true);
   if(!validReceipt(body.receipt,requestId,this.pending?.command)||!body.snapshot)throw failure('LOCAL_RECEIPT_INVALID',true);
   if(this.pending?.requestId===requestId)this.clear();
   return body.receipt;
  }catch(error){this.error=error.code||'LOCAL_RESULT_UNKNOWN';this.changed();throw failure(this.error,true);}
 }
 command(command,payload,requestId){
  if(this.inflight){if(this.pending?.requestId===requestId&&canonical(this.pending.payload)===canonical(payload)&&this.pending.command===command)return this.inflight;return Promise.reject(failure('LOCAL_COMMAND_PENDING'));}
  if(this.pending)return this.pending.requestId===requestId&&this.pending.command===command&&canonical(this.pending.payload)===canonical(payload)?this.recover(requestId):Promise.reject(failure('LOCAL_COMMAND_PENDING',true));
  if(!validId(requestId)||!['create','action','prices','fixture-receipt','new-risk'].includes(command)||!payload||typeof payload!=='object')return Promise.reject(failure('LOCAL_COMMAND_INVALID'));
  if(this.pendingError||this.state!=='LIVE'||!this.snapshot)return Promise.reject(failure('LOCAL_SERVICE_UNAVAILABLE'));
  const envelope={fixtureId:this.fixtureId,ownerEpoch:this.snapshot.owner.epoch,expectedRevision:this.snapshot.revision,requestId,command,payload:copy(payload)};
  try{this.retain(envelope);}catch{return Promise.reject(failure('LOCAL_STORAGE_UNAVAILABLE'));}
  this.inflight=(async()=>{
   try{
    let response,body;
    try{({response,body}=await this.request('/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope)}));}
    catch{this.state='OFFLINE';this.error='LOCAL_RESULT_UNKNOWN';this.changed();return await this.recover(requestId);}
    if(validReceipt(body?.receipt,requestId,command)&&body.snapshot){this.clear();return body.receipt;}
    if(body?.receipt||![400,403,422].includes(response.status)||body?.queryOriginalRequest)return await this.recover(requestId);
    this.clear();throw failure(body?.code||body?.error||'LOCAL_COMMAND_REJECTED');
   }finally{this.inflight=null;}
  })();return this.inflight;
 }
}
