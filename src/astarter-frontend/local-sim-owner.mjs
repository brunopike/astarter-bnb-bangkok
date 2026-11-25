import {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,lstatSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {TradingDemo} from './trading-demo.mjs';
import {BOT_MARKETS} from './bot-runtime.mjs';
import {ResidentBotBook} from './local-sim-runtime.mjs';

const clone=value=>structuredClone(value);
const plain=value=>typeof value==='object'&&value!==null&&Object.getPrototypeOf(value)===Object.prototype;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const canonical=value=>JSON.stringify(value,(_,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
const digest=value=>createHash('sha256').update(value).digest('hex');
const closed=(value,allowed)=>plain(value)&&Object.keys(value).every(k=>allowed.includes(k));
const problem=code=>Object.assign(Error(code),{code});
const pidAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const activeOrder=order=>['submitted','partial','unknown'].includes(order.status);
const schema='astarter-isolated-local-sim-v1';

export function createLocalSimOwner(options){return new LocalSimOwner(options);}

// Fixed synthetic quotes/fees only; a real venue requires a separate approved adapter.
class LocalSimOwner{
 constructor({databasePath,fixtureId,connectionId='local-fixture',create=false,seedCash=1000,clock=()=>performance.now(),intervalMs=100}={}){
  if(typeof databasePath!=='string'||!isAbsolute(databasePath)||!id(fixtureId)||!id(connectionId)||typeof create!=='boolean'||!Number.isFinite(seedCash)||seedCash<=0||seedCash>1000000||typeof clock!=='function'||!Number.isSafeInteger(intervalMs)||intervalMs<10||intervalMs>1000)throw problem('OWNER_CONFIG_INVALID');
  this.databasePath=databasePath;this.fixtureId=fixtureId;this.connectionId=connectionId;this.clock=clock;this.intervalMs=intervalMs;this.nonce=randomUUID();this.status='READY';this.active=false;this.accountingUnknown=false;this.startedAt=Date.now();this.lastTickAt=null;this.tickCount=0;this.timer=null;
  try{
   if(create){try{closeSync(openSync(databasePath,'wx',0o600));}catch{throw problem('STORE_EXISTS');}}
   const stat=lstatSync(databasePath);if(!stat.isFile()||stat.isSymbolicLink())throw problem('STORE_UNAVAILABLE');this.identity={dev:stat.dev,ino:stat.ino};
   const uri=pathToFileURL(databasePath);uri.searchParams.set('mode','rw');this._db=new DatabaseSync(uri.href);
   if(create)this._initialize(seedCash);
   const meta=this._db.prepare('SELECT * FROM local_sim_meta WHERE id=1').get();
   if(!meta||meta.schema_id!==schema||meta.fixture_id!==fixtureId||meta.connection_id!==connectionId)throw problem('STORE_SCOPE_MISMATCH');
   this.seedCash=meta.seed_cash;
   const saved=this._db.prepare('SELECT * FROM local_sim_snapshot WHERE id=1').get();
   if(!saved||digest(saved.payload)!==saved.sha256)throw problem('STORE_INVALID');
   const bundle=JSON.parse(saved.payload);this._hydrate(bundle,!create);this.stateRevision=saved.state_revision;this._assertFinancial();
   this._db.exec('BEGIN IMMEDIATE');
   const old=this._db.prepare('SELECT * FROM local_sim_controller WHERE id=1').get();
   if(old.status!=='STOPPED'&&pidAlive(old.pid))throw problem('OWNER_CONFLICT');
   this.previousPid=old.pid||null;this.epoch=old.epoch+1;
   this._db.prepare('UPDATE local_sim_controller SET epoch=?,pid=?,nonce=?,status=? WHERE id=1').run(this.epoch,process.pid,this.nonce,'READY');
   const draft=this._capture();this._save(draft);this._db.exec('COMMIT');this._adopt(draft);
  }catch(e){try{this._db?.exec('ROLLBACK');}catch{}try{this._db?.close();}catch{}this._db=null;throw problem(e.code&&String(e.code).startsWith('OWNER_')||e.code&&String(e.code).startsWith('STORE_')?e.code:'STORE_UNAVAILABLE');}
 }
 _initialize(seedCash){
  this._db.exec('BEGIN IMMEDIATE');
  this._db.exec('CREATE TABLE local_sim_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_id TEXT NOT NULL,fixture_id TEXT NOT NULL,connection_id TEXT NOT NULL,seed_cash REAL NOT NULL); CREATE TABLE local_sim_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),state_revision INTEGER NOT NULL,payload TEXT NOT NULL,sha256 TEXT NOT NULL); CREATE TABLE local_sim_controller(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,pid INTEGER NOT NULL,nonce TEXT NOT NULL,status TEXT NOT NULL); CREATE TABLE local_sim_requests(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL)');
  const demo=new TradingDemo();demo.cash=seedCash;const {records,...data}=demo;
  const book=new ResidentBotBook({fixtureId:this.fixtureId});
  const priceFeed=Object.fromEntries(Object.keys(BOT_MARKETS).map(key=>[key,this._generatorQuote(0)]));
  const bundle={schema:'LocalSimBundle.v1',fixtureId:this.fixtureId,connectionId:this.connectionId,seedCash,demo:{...data,flow:records.data},book:book.snapshot(),newRiskPaused:true,commandRevision:0,prices:{...BOT_MARKETS},priceFeed,recovery:{phase:'FRESH',verifiedAt:Date.now()}};
  const payload=canonical(bundle);
  this._db.prepare('INSERT INTO local_sim_meta VALUES(1,?,?,?,?)').run(schema,this.fixtureId,this.connectionId,seedCash);
  this._db.prepare('INSERT INTO local_sim_snapshot VALUES(1,0,?,?)').run(payload,digest(payload));
  this._db.prepare('INSERT INTO local_sim_controller VALUES(1,0,0,?,?)').run('','STOPPED');this._db.exec('COMMIT');
 }
 _hydrate(bundle,recover){
  if(!closed(bundle,['schema','fixtureId','connectionId','seedCash','demo','book','newRiskPaused','commandRevision','prices','priceFeed','recovery'])||bundle.schema!=='LocalSimBundle.v1'||bundle.fixtureId!==this.fixtureId||bundle.connectionId!==this.connectionId||bundle.seedCash!==this.seedCash||typeof bundle.newRiskPaused!=='boolean'||!Number.isSafeInteger(bundle.commandRevision)||bundle.commandRevision<0||!plain(bundle.demo)||bundle.demo.position!==null||bundle.demo.session!==null||bundle.demo.pending!==null||!Array.isArray(bundle.demo.orders)||bundle.demo.orders.length||!this._pricesValid(bundle.prices)||!plain(bundle.priceFeed)||Object.keys(bundle.priceFeed).length!==Object.keys(bundle.prices).length||Object.keys(bundle.prices).some(key=>!this._quoteValid(bundle.priceFeed[key])))throw problem('STORE_INVALID');
  this.demo=new TradingDemo();if(!this.demo.restore(bundle.demo))throw problem('STORE_INVALID');
  this.newRiskPaused=recover||bundle.newRiskPaused;this.commandRevision=bundle.commandRevision;this.prices=clone(bundle.prices);this.priceFeed=clone(bundle.priceFeed);this.recovery=clone(bundle.recovery);
  this.book=new ResidentBotBook({fixtureId:this.fixtureId,state:bundle.book,
   debit:n=>{if(!Number.isFinite(n)||n<0||n>this.demo.availableCash)return false;this.demo.cash-=n;return true;},
   credit:n=>{if(!Number.isFinite(n)||n<0||!Number.isFinite(this.demo.cash+n))return false;this.demo.cash+=n;return true;},
   canBuy:()=>this.newRiskPaused?'本地工作区新增买入保持暂停。':true,
   marketReady:market=>this._quoteState(market)==='fresh',
  });
  if(recover){this.book.resumeProtection();this.recovery={phase:'PROTECTION_ONLY',verifiedAt:Date.now()};}
 }
 _pricesValid(prices){return plain(prices)&&Object.keys(prices).length>0&&Object.keys(prices).length<=3&&Object.entries(prices).every(([key,value])=>Object.hasOwn(BOT_MARKETS,key)&&typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=1e12);}
 _clockRefValid(ref){return closed(ref,['kind','ref','unit'])&&ref.kind==='SIM'&&ref.ref===this.fixtureId&&ref.unit==='ms';}
 _quoteValid(quote){return closed(quote,['feedMode','clockRef','asOfMs','validUntilMs','sourceId'])&&['generator','snapshot'].includes(quote.feedMode)&&this._clockRefValid(quote.clockRef)&&Number.isSafeInteger(quote.asOfMs)&&quote.asOfMs>=0&&Number.isSafeInteger(quote.validUntilMs)&&quote.validUntilMs>quote.asOfMs&&quote.sourceId===(quote.feedMode==='generator'?'FIXED_LOCAL_FIXTURE_GENERATOR':'CONTROLLED_LOCAL_SNAPSHOT');}
 _generatorQuote(now){return {feedMode:'generator',clockRef:{kind:'SIM',ref:this.fixtureId,unit:'ms'},asOfMs:now,validUntilMs:now+1000,sourceId:'FIXED_LOCAL_FIXTURE_GENERATOR'};}
 _quoteState(market,now=Math.round((this.book?.s.time||0)*1000)){
  const quote=this.priceFeed?.[market];if(!quote)return 'unavailable';return now<quote.asOfMs?'future':now>=quote.validUntilMs?'stale':'fresh';
 }
 _pauseForStale(now){if(this.book.s.runs.some(run=>!['stopped','failed'].includes(run.status)&&this._quoteState(run.plan.market,now)!=='fresh'))this.newRiskPaused=true;}
 _assertFinancial(){
  if(!Number.isFinite(this.demo.cash)||this.demo.cash<0||Math.abs(this.demo.cash+this.book.s.runs.reduce((n,run)=>n+run.initialAllocation-run.returned,0)-this.seedCash)>1e-8)throw problem('LOCAL_ACCOUNT_INVARIANT');
  if(this.book.s.runs.some(run=>run.plan.executionRoute.connectionId!==this.connectionId||run.plan.executionRoute.accountId!=='SIM-01'||run.plan.environment!=='DEMO'))throw problem('STORE_SCOPE_MISMATCH');
 }
 _pending(){return [...new Set([...this.book.s.runs.flatMap(run=>run.orders.filter(o=>o.status==='unknown').map(o=>o.id)),...this.book.control.cancelRequests.filter(row=>row.state!=='RECONCILED').map(row=>row.orderId),...this.book.control.receiptConflicts.map(row=>row.orderId)])];}
 _capture(){
  this._assertFinancial();const {records,...demo}=this.demo;
  const bundle={schema:'LocalSimBundle.v1',fixtureId:this.fixtureId,connectionId:this.connectionId,seedCash:this.seedCash,demo:{...clone(demo),flow:clone(records.data)},book:this.book.snapshot(),newRiskPaused:this.newRiskPaused,commandRevision:this.commandRevision,prices:clone(this.prices),priceFeed:clone(this.priceFeed),recovery:clone(this.recovery)};
  const summary=this.book.summary(),orderIds=new Set(this.book.s.runs.flatMap(run=>run.orders.map(o=>o.id))),orderHeld=this.book.flow.reservations.filter(row=>orderIds.has(row.orderId)&&row.state==='HELD'&&row.unit==='USDT').reduce((n,row)=>n+Number(row.amount),0);
  const cash=this.demo.cash+summary.cash,available=this.demo.availableCash;
  const accountSummary={accountId:'SIM-01',fixtureId:this.fixtureId,environment:'DEMO',unit:'USDT',clockKind:'SIM',asOf:this.book.s.time,equity:this.demo.cash+summary.equity,cash,available,reserved:Math.max(0,cash-available),positions:this.book.s.runs.filter(run=>run.quantity>0).length,orders:this.book.s.runs.flatMap(run=>run.orders).filter(activeOrder).length,orderHeld,allocatedFreeCash:this.book.s.runs.reduce((n,run)=>n+run.freeCash,0),cashAfterOrderHolds:cash-orderHeld};
  const quotes=Object.fromEntries(Object.entries(this.priceFeed).map(([market,quote])=>[market,{...clone(quote),price:this.prices[market],state:this._quoteState(market)}]));
  return {bundle,quotes,trade:{...clone(bundle.demo),mode:'isolated-local-sim',legacySeq:this.demo.seq,seq:this.demo.seq+this.book.s.revision,botBook:clone(bundle.book),botSummary:{...summary,revision:this.book.s.revision,recoveryError:null},accountSummary},pending:this._pending(),stateRevision:this.stateRevision+1};
 }
 _save(draft){
  this._checkPath();const payload=canonical(draft.bundle);
  if(payload.length>8000000)throw problem('FIXTURE_STATE_LIMIT');
  const result=this._db.prepare('UPDATE local_sim_snapshot SET state_revision=?,payload=?,sha256=? WHERE id=1 AND state_revision=?').run(draft.stateRevision,payload,digest(payload),this.stateRevision);
  if(Number(result.changes)!==1)throw problem('STORE_CAS_CONFLICT');
 }
 _adopt(draft){this.lastBundle=clone(draft.bundle);this.lastTrade=clone(draft.trade);this.lastQuotes=clone(draft.quotes);this.lastPending=clone(draft.pending);this.stateRevision=draft.stateRevision;}
 _checkPath(){const stat=lstatSync(this.databasePath);if(stat.isSymbolicLink()||stat.dev!==this.identity.dev||stat.ino!==this.identity.ino)throw problem('STORE_IDENTITY_CHANGED');}
 _fence(){
  this._checkPath();const row=this._db.prepare('SELECT * FROM local_sim_controller WHERE id=1').get();
  if(row.epoch!==this.epoch||row.nonce!==this.nonce||row.pid!==process.pid)throw problem('OWNER_FENCED');
 }
 _fail(){this.active=false;this.accountingUnknown=true;clearInterval(this.timer);this.timer=null;this.status='FAILED';}
 start(){
  if(this.active)return this.snapshot();if(!this._db||this.status==='FAILED'||this.status==='STOPPED')throw problem('OWNER_STOPPED');
  this._fence();this._db.prepare('UPDATE local_sim_controller SET status=? WHERE id=1 AND epoch=? AND nonce=?').run('RUNNING',this.epoch,this.nonce);
  this.status='RUNNING';this.active=true;this.lastClock=this.clock();this.timer=setInterval(()=>this._cycle(),this.intervalMs);return this.snapshot();
 }
 _cycle(){
  if(!this.active)return;
  const now=this.clock(),dt=(now-this.lastClock)/1000;if(dt===0)return;
  try{
   if(!Number.isFinite(dt)||dt<0||dt>3600)throw problem('OWNER_CLOCK_INVALID');
   this._db.exec('BEGIN IMMEDIATE');this._fence();
   const quoteNow=Math.round((this.book.s.time+dt)*1000);
   for(const [market,quote]of Object.entries(this.priceFeed))if(quote.feedMode==='generator')this.priceFeed[market]=this._generatorQuote(quoteNow);
   this._pauseForStale(quoteNow);
   const result=this.book.tick(dt,this.prices);if(result.error)throw problem(result.code);this.demo.time=this.book.s.time;
   const draft=this._capture();this._save(draft);this._db.exec('COMMIT');this._adopt(draft);this.lastClock=now;this.lastTickAt=Date.now();this.tickCount++;
  }catch{try{this._db.exec('ROLLBACK');}catch{}this._fail();}
 }
 snapshot(){
  const conflictOrderIds=[...new Set(this.lastBundle.book.residentControl.receiptConflicts.map(row=>row.orderId))];
  return {schema:'AstarterLocalSim.v1',mode:'ISOLATED_LOCAL_SIMULATION',fixtureId:this.fixtureId,revision:this.lastBundle.commandRevision,stateRevision:this.stateRevision,
   owner:{epoch:this.epoch,pid:process.pid,processVersion:process.version,execPath:process.execPath,state:this.status,lastTickAt:this.lastTickAt,tickCount:this.tickCount,protectionAvailable:this.active&&this.status==='RUNNING'},
   recovery:{...clone(this.lastBundle.recovery),phase:this.accountingUnknown?'STORE_UNKNOWN':conflictOrderIds.length?'RECEIPT_CONFLICT':this.lastPending.length?'WAITING_RECEIPTS':this.lastBundle.recovery.phase,previousPid:this.previousPid,pendingOrderIds:clone(this.lastPending),conflictOrderIds,newRiskPaused:this.lastBundle.newRiskPaused,accountingKnown:!this.accountingUnknown},
   capabilities:{nativeAccepted:false,realTrading:false,protectionScope:'LOCAL_PROCESS_ONLY'},prices:clone(this.lastBundle.prices),quotes:clone(this.lastQuotes),trade:clone(this.lastTrade)};
 }
 request(requestId){
  if(!id(requestId))return {ok:false,code:'COMMAND_INVALID'};
  if(!this._db)return {ok:false,code:'OWNER_STOPPED',snapshot:this.snapshot()};
  try{const row=this._db.prepare('SELECT receipt FROM local_sim_requests WHERE request_id=?').get(requestId);return row?{ok:true,receipt:JSON.parse(row.receipt),snapshot:this.snapshot()}:{ok:false,code:'REQUEST_NOT_FOUND',snapshot:this.snapshot()};}catch{return {ok:false,code:'STORE_UNAVAILABLE',queryOriginalRequest:true,snapshot:this.snapshot()};}
 }
 dispatch(input){
  if(!closed(input,['fixtureId','ownerEpoch','expectedRevision','requestId','command','payload'])||!id(input.requestId)||!Number.isSafeInteger(input.ownerEpoch)||input.ownerEpoch<0||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||typeof input.command!=='string'||!plain(input.payload))return {ok:false,code:'COMMAND_INVALID'};
  if(input.fixtureId!==this.fixtureId)return {ok:false,code:'FIXTURE_SCOPE_MISMATCH'};
  if(!this.active||!this._db)return {ok:false,code:'OWNER_STOPPED',snapshot:this.snapshot()};
  let fingerprint;try{fingerprint=digest(canonical({fixtureId:input.fixtureId,command:input.command,payload:input.payload}));}catch{return {ok:false,code:'COMMAND_INVALID'};}
  try{
   this._db.exec('BEGIN IMMEDIATE');this._fence();
   const previous=this._db.prepare('SELECT * FROM local_sim_requests WHERE request_id=?').get(input.requestId);
   if(previous){
    this._db.exec('COMMIT');if(previous.fingerprint!==fingerprint)return {ok:false,code:'REQUEST_CONFLICT',snapshot:this.snapshot()};
    const receipt=JSON.parse(previous.receipt);
    if(input.ownerEpoch!==this.epoch)return {ok:false,code:'OWNER_FENCED',attemptAccepted:false,queryOriginalRequest:true,receipt,snapshot:this.snapshot()};
    return {ok:receipt.ok,...(receipt.code?{code:receipt.code}:{}),receipt,duplicate:true,snapshot:this.snapshot()};
   }
   if(input.ownerEpoch!==this.epoch||input.expectedRevision!==this.commandRevision){
    const code=input.ownerEpoch!==this.epoch?'OWNER_FENCED':'REVISION_CONFLICT';
    const receipt={requestId:input.requestId,command:input.command,revision:this.commandRevision,requestStatus:'NOT_ACCEPTED',ok:false,code,result:{}};
    this._db.prepare('INSERT INTO local_sim_requests VALUES(?,?,?)').run(input.requestId,fingerprint,JSON.stringify(receipt));this._db.exec('COMMIT');
    return {ok:false,code,receipt,attemptAccepted:false,snapshot:this.snapshot()};
   }
   const result=this._command(input);this.commandRevision++;
   const receipt={requestId:input.requestId,command:input.command,revision:this.commandRevision,requestStatus:'COMMITTED',ok:!result.error,...(result.code?{code:result.code}:{}),result:{...(result.run?{runId:result.run.id}:{}),...(result.operation?{operation:result.operation}:{}),...(result.duplicate?{duplicate:true}:{}),...(result.ignoredStale!==undefined?{ignoredStale:result.ignoredStale}:{})}};
   const draft=this._capture();this._save(draft);this._db.prepare('INSERT INTO local_sim_requests VALUES(?,?,?)').run(input.requestId,fingerprint,JSON.stringify(receipt));this._db.exec('COMMIT');this._adopt(draft);
   return {ok:receipt.ok,...(receipt.code?{code:receipt.code}:{}),receipt,snapshot:this.snapshot()};
  }catch{try{this._db.exec('ROLLBACK');}catch{}this._fail();return {ok:false,code:'OUTCOME_UNKNOWN_QUERY',requestId:input.requestId,queryOriginalRequest:true,snapshot:this.snapshot()};}
 }
 _command({command,payload,requestId}){
  const reject=code=>({code,error:code});
  if(command==='new-risk'){
   if(!closed(payload,['enabled'])||typeof payload.enabled!=='boolean')return reject('COMMAND_INVALID');
   if(payload.enabled&&this._pending().length)return reject('RECONCILIATION_REQUIRED');
   if(payload.enabled&&this.book.s.runs.some(run=>!['stopped','failed'].includes(run.status)&&this._quoteState(run.plan.market)!=='fresh'))return reject('MARKET_NOT_READY');
   this.newRiskPaused=!payload.enabled;return {};
  }
  if(command==='prices'){
   if(!closed(payload,['prices','feedMode','clockRef','asOfMs','validUntilMs'])||!this._pricesValid(payload.prices)||payload.feedMode!==undefined&&!['generator','snapshot'].includes(payload.feedMode))return reject('PRICE_INVALID');
   const mode=payload.feedMode||'generator',now=Math.round(this.book.s.time*1000);
   const quote=mode==='generator'?this._generatorQuote(now):{feedMode:'snapshot',clockRef:payload.clockRef,asOfMs:payload.asOfMs,validUntilMs:payload.validUntilMs,sourceId:'CONTROLLED_LOCAL_SNAPSHOT'};
   if(!this._quoteValid(quote)||mode==='generator'&&['clockRef','asOfMs','validUntilMs'].some(k=>payload[k]!==undefined))return reject('PRICE_CLOCK_INVALID');
   for(const [market,price]of Object.entries(payload.prices)){
    this.prices[market]=price;this.priceFeed[market]=clone(quote);
    for(const run of this.book.s.runs)if(run.plan.market===market){
     run.priceQuality=this._quoteState(market,now)==='fresh'?'fresh':'stale';
     if(run.priceQuality==='fresh'){run.markPrice=price;run.priceSource='INJECTED_PAPER_PRICE';}
     this.book._sync(run);
    }
   }
   this.book._changed();this._pauseForStale(now);return {};
  }
  if(command==='create'){
   if(!closed(payload,['plan'])||!plain(payload.plan))return reject('COMMAND_INVALID');
   if(payload.plan.executionRoute?.connectionId!==this.connectionId||payload.plan.executionRoute?.accountId!=='SIM-01')return reject('SCOPE_MISMATCH');
   if(this._quoteState(payload.plan.market)!=='fresh')return reject('MARKET_NOT_READY');
   if(this.newRiskPaused)return reject('NEW_RISK_PAUSED');return this.book.create(payload.plan,{requestId});
  }
  if(command==='action'){
   if(!closed(payload,['runId','kind','orderId','cancelScenario'])||!id(payload.runId)||!['pause','resume','stop-close','stop-keep','close-position','cancel','query'].includes(payload.kind))return reject('COMMAND_INVALID');
   if(payload.kind==='resume'&&this.newRiskPaused)return reject('NEW_RISK_PAUSED');
   return this.book.action(payload.runId,payload.kind,{requestId,expectedAccountId:'SIM-01',expectedConnectionId:this.connectionId,...(payload.orderId!==undefined?{orderId:payload.orderId}:{}),...(payload.cancelScenario!==undefined?{cancelScenario:payload.cancelScenario}:{})});
  }
  if(command==='fixture-receipt'){
   const result=this.book.receiveReceipt(payload);if(this.book.control.receiptConflicts.length)this.newRiskPaused=true;return result;
  }
  return reject('COMMAND_INVALID');
 }
 close(){
  if(this.status==='STOPPED')return;this.active=false;clearInterval(this.timer);this.timer=null;
  if(this._db){try{this._db.prepare('UPDATE local_sim_controller SET status=? WHERE id=1 AND epoch=? AND nonce=?').run('STOPPED',this.epoch,this.nonce);}catch{}try{this._db.close();}catch{}this._db=null;}
  this.status='STOPPED';
 }
}
