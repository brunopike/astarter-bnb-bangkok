import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateTradingConnectionCommand,validateTradingConnectionState,validateTradingConnectionCheck,validateTradingConnectionCommandResult,CONNECTION_STATUSES,CONNECTION_CHECK_CODES} from './trading-connection-data.mjs';
import {TradingAccess} from './trading-access.mjs';
import {normalizeTradingConnections,normalizeConnectionPreferences} from './connection-options.mjs';

// Card A1 gate fallback: contract and synthetic receipts. A pass here is wire evidence
// only and never shows that an account, a venue or a credential store is connected.
const fixture=JSON.parse(readFileSync(new URL('./trading-connection-contract-fixtures.json',import.meta.url),'utf8'));
const OWNER=fixture.owners.a,OTHER=fixture.owners.b,NOW=fixture.state.updatedAt,VERIFY=fixture.commands.verify;
const copy=value=>structuredClone(value),fail=(run,code='PRIVATE_UI_PROTOCOL')=>assert.throws(run,error=>error.code===code&&error.message===code&&error.status===(code==='PRIVATE_REQUEST_INVALID'?400:502));
const state=(patch={})=>({...copy(fixture.state),...patch});
const withRecord=(id,patch)=>{const value=copy(fixture.state);Object.assign(value.connections.find(item=>item.connectionId===id),patch);return value;};
function verified(kind){
 const check=copy(fixture.checks[kind]),next=withRecord(check.connectionId,{status:check.status,checkedAt:check.checkedAt,checkCode:check.code,checkSource:check.source});
 next.revision=VERIFY.baseRevision+1;next.updatedAt=check.checkedAt;
 return {request:{schema:'private-ui-command-v1',domain:'connections',requestId:VERIFY.requestId,status:'applied',baseRevision:VERIFY.baseRevision,revision:next.revision,appliedAt:check.checkedAt},state:next,check};
}

test('the shared fixture is synthetic wire evidence and every state, command and check passes as an exact independent copy',()=>{
 assert.equal(fixture.contract,'trading-connection-v1');assert.equal(fixture.evidenceGrade,'SYNTHETIC_WIRE_ONLY');
 for(const [value,owner]of [[fixture.state,OWNER],[fixture.stateOtherOwner,OTHER]]){
  const result=validateTradingConnectionState(copy(value),owner);assert.deepEqual(result,value);
  result.connections[0].label='Changed returned copy';assert.notEqual(value.connections[0].label,result.connections[0].label);
 }
 for(const input of Object.values(fixture.commands))assert.deepEqual(validateTradingConnectionCommand(copy(input)),input);
 for(const check of Object.values(fixture.checks)){assert.deepEqual(validateTradingConnectionCheck(copy(check)),check);assert.equal(check.source,'synthetic');assert.ok(check.code===null||CONNECTION_CHECK_CODES.includes(check.code));}
 for(const record of [...fixture.state.connections,...fixture.stateOtherOwner.connections]){assert.notEqual(record.checkSource,'venue');assert.equal(record.credentialRef,null);assert.ok(CONNECTION_STATUSES.includes(record.status));}
});

test('two owners never read each other and no command can name an owner or an account',()=>{
 fail(()=>validateTradingConnectionState(copy(fixture.state),OTHER));fail(()=>validateTradingConnectionState(copy(fixture.stateOtherOwner),OWNER));
 assert.equal(validateTradingConnectionState(copy(fixture.state),OWNER).connections[0].venue,'binance');
 assert.equal(validateTradingConnectionState(copy(fixture.stateOtherOwner),OTHER).connections[0].venue,'okx');
 fail(()=>validateTradingConnectionCommandResult(verified('connected'),VERIFY.requestId,OTHER));
 for(const [key,value]of Object.entries({ownerRef:OTHER,scope:OTHER,owner:OTHER,tenantId:'other',subjectId:'other',userId:'other',accountId:'SIM-02',executionAuthority:'NONE'}))for(const action of Object.keys(fixture.commands)){
  const outer=copy(fixture.commands[action]);outer[key]=value;fail(()=>validateTradingConnectionCommand(outer),'PRIVATE_REQUEST_INVALID');
  const inner=copy(fixture.commands[action]);inner.payload[key]=value;fail(()=>validateTradingConnectionCommand(inner),'PRIVATE_REQUEST_INVALID');
 }
});

test('the owner is required: a state or a command result checked without the session owner fails',()=>{
 fail(()=>validateTradingConnectionState(copy(fixture.state)));fail(()=>validateTradingConnectionState(copy(fixture.stateOtherOwner)));
 for(const owner of [undefined,null,'',42,[OWNER],{scope:OWNER},OWNER+' '])fail(()=>validateTradingConnectionState(copy(fixture.state),owner));
 fail(()=>validateTradingConnectionCommandResult(verified('connected'),VERIFY.requestId));fail(()=>validateTradingConnectionCommandResult(verified('connected'),VERIFY.requestId,undefined));
 // The same values pass once the session owner is named, so only the missing owner fails them.
 assert.equal(validateTradingConnectionState(copy(fixture.state),OWNER).scope,OWNER);
 assert.equal(validateTradingConnectionCommandResult(verified('connected'),VERIFY.requestId,OWNER).state.scope,OWNER);
});

test('credentials never travel in a command and only an opaque reference may appear in state',()=>{
 for(const key of ['apiKey','apiSecret','secret','passphrase','password','privateKey','mnemonic','credentials','credentialRef','token'])for(const action of Object.keys(fixture.commands)){
  const outer=copy(fixture.commands[action]);outer[key]='demo-value';fail(()=>validateTradingConnectionCommand(outer),'PRIVATE_REQUEST_INVALID');
  const inner=copy(fixture.commands[action]);inner.payload[key]='demo-value';fail(()=>validateTradingConnectionCommand(inner),'PRIVATE_REQUEST_INVALID');
 }
 for(const label of ['Bearer '+'x'.repeat(24),'sk-or-v1-'+'x'.repeat(24),'https://user:password@example.test','0x'+'a'.repeat(64),'a'.repeat(64),'bad\nlabel','<b>bold</b>',' ','x'.repeat(41)]){const input=copy(fixture.commands.save);input.payload.label=label;fail(()=>validateTradingConnectionCommand(input),'PRIVATE_REQUEST_INVALID');}
 for(const id of ['0x'+'a'.repeat(64),'a'.repeat(64),'sk-live-key','-leading','has space','','x'.repeat(81),42,null]){const input=copy(VERIFY);input.payload.connectionId=id;fail(()=>validateTradingConnectionCommand(input),'PRIVATE_REQUEST_INVALID');}
 assert.equal(validateTradingConnectionState(withRecord('api-main',{credentialRef:'credential-ref-0001'}),OWNER).connections[0].credentialRef,'credential-ref-0001');
 for(const credentialRef of ['short','sk-or-v1-'+'x'.repeat(24),'0x'+'a'.repeat(64),'a'.repeat(64),'has space in reference',42,{ref:'x'}])fail(()=>validateTradingConnectionState(withRecord('api-main',{credentialRef}),OWNER));
 fail(()=>validateTradingConnectionState(withRecord('wallet-arb',{credentialRef:'credential-ref-0001'}),OWNER));
 for(const key of ['apiKey','secret','passphrase','balances'])fail(()=>validateTradingConnectionState(withRecord('api-main',{[key]:'demo-value'}),OWNER));
});

test('records carry the card fields and reject anything outside the venue, market, chain, permission and status lists',()=>{
 const keys=['accountId','chain','checkCode','checkSource','checkedAt','connectionId','credentialRef','label','market','permissions','status','venue','venueType'];
 for(const record of fixture.state.connections)assert.deepEqual(Object.keys(record).sort(),keys);
 assert.deepEqual(CONNECTION_STATUSES,['unchecked','connected','disconnected','denied','expired']);
 for(const patch of [{venue:'unknown'},{venueType:'OTC'},{market:'margin'},{chain:'42161'},{permissions:['read','withdraw']},{permissions:['trade']},{permissions:['read','confirm']},{permissions:[]},{permissions:['read','trade','withdraw']},{status:'verified'},{checkCode:'other'},{checkSource:'manual'},{accountId:''},{label:''}])fail(()=>validateTradingConnectionState(withRecord('api-main',patch),OWNER));
 for(const patch of [{venue:'binance'},{chain:''},{chain:'10'},{market:'perp'},{permissions:['read','trade']}])fail(()=>validateTradingConnectionState(withRecord('wallet-arb',patch),OWNER));
 for(const patch of [{chain:'solana:mainnet'},{market:'spot'}])fail(()=>validateTradingConnectionState(withRecord('wallet-hl',patch),OWNER));
 const duplicate=copy(fixture.state);duplicate.connections.push(copy(duplicate.connections[0]));fail(()=>validateTradingConnectionState(duplicate,OWNER));
 fail(()=>validateTradingConnectionState(state({connections:Array.from({length:21},(_,index)=>({...copy(fixture.state.connections[1]),connectionId:'api-'+index}))}),OWNER));
 for(const patch of [{schema:'trading-connections-v2'},{executionAuthority:'TRADE'},{revision:-1},{updatedAt:1.5},{balances:[]}])fail(()=>validateTradingConnectionState(state(patch),OWNER));
});

test('a record never reports a check it cannot show',()=>{
 for(const patch of [{checkedAt:null},{checkSource:null},{checkedAt:null,checkSource:null},{checkCode:'withdraw'},{checkSource:'venue'}])fail(()=>validateTradingConnectionState(withRecord('api-main',patch),OWNER));
 fail(()=>validateTradingConnectionState(withRecord('api-denied',{checkCode:null}),OWNER));
 fail(()=>validateTradingConnectionState(withRecord('wallet-hl',{checkedAt:null,checkSource:null}),OWNER));
 fail(()=>validateTradingConnectionState(withRecord('api-perp',{checkedAt:NOW}),OWNER));
 const waiting=validateTradingConnectionState(withRecord('api-perp',{checkedAt:NOW,checkCode:'timeout',checkSource:'synthetic'}),OWNER);
 assert.equal(waiting.connections[1].status,'unchecked');
 // Shape only: a venue check of an exchange key needs a stored credential reference.
 assert.equal(validateTradingConnectionState(withRecord('api-main',{checkSource:'venue',credentialRef:'credential-ref-0001'}),OWNER).connections[0].checkSource,'venue');
});

test('a read-only check connects only when withdrawals are observed off, and a failure carries a code and no balances',()=>{
 const base=fixture.checks.connected;
 for(const patch of [{withdrawalsEnabled:true},{withdrawalsEnabled:null},{code:'timeout'},{permissions:['read','withdraw']},{permissions:['read','read']},{balances:[{asset:'USDT',free:'-1',locked:'0'}]},{balances:[{asset:'USDT',free:1000,locked:'0'}]},{balances:[{asset:'usdt',free:'1',locked:'0'}]},{balances:[{asset:'USDT',free:'1',locked:'0'},{asset:'USDT',free:'2',locked:'0'}]},{balances:[{asset:'USDT',free:'1',locked:'0',address:'x'}]},{source:'manual'},{executionAuthority:'TRADE'},{schema:'trading-connection-check-v2'},{checkedAt:-1},{status:'verified'}])fail(()=>validateTradingConnectionCheck({...copy(base),...patch}));
 for(const [kind,patch]of [['withdraw',{status:'connected'}],['withdraw',{withdrawalsEnabled:false}],['withdraw',{status:'unchecked'}],['permissions',{code:null}],['permissions',{withdrawalsEnabled:true}],['permissions',{code:'other'}],['timeout',{balances:[{asset:'USDT',free:'1',locked:'0'}]}],['timeout',{status:'connected'}]])fail(()=>validateTradingConnectionCheck({...copy(fixture.checks[kind]),...patch}));
 assert.ok(CONNECTION_CHECK_CODES.includes('withdraw'));assert.equal(fixture.checks.withdraw.status,'denied');assert.deepEqual(fixture.checks.withdraw.balances,[]);
});

test('a verify result is accepted only when the receipt and the stored record report the same check',()=>{
 for(const kind of Object.keys(fixture.checks)){const value=verified(kind);assert.deepEqual(validateTradingConnectionCommandResult(copy(value),VERIFY.requestId,OWNER),value);}
 const split=verified('connected');split.state.connections.find(item=>item.connectionId==='api-perp').status='unchecked';fail(()=>validateTradingConnectionCommandResult(split,VERIFY.requestId,OWNER));
 const missing=verified('connected');missing.check.connectionId='api-unknown';fail(()=>validateTradingConnectionCommandResult(missing,VERIFY.requestId,OWNER));
 for(const patch of [{requestId:'connection-verify-0002'},{domain:'workspace'},{status:'pending'},{revision:9},{appliedAt:fixture.checks.connected.checkedAt-1}]){const value=verified('connected');Object.assign(value.request,patch);fail(()=>validateTradingConnectionCommandResult(value,VERIFY.requestId,OWNER));}
 fail(()=>validateTradingConnectionCommandResult(verified('connected'),'short',OWNER));
 const input=fixture.commands.prefer,next=state({revision:input.baseRevision+1,preferences:[...copy(fixture.state.preferences),copy(input.payload)]});
 const applied={request:{schema:'private-ui-command-v1',domain:'connections',requestId:input.requestId,status:'applied',baseRevision:input.baseRevision,revision:next.revision,appliedAt:NOW},state:next,check:null};
 assert.deepEqual(validateTradingConnectionCommandResult(copy(applied),input.requestId,OWNER),applied);
 const extra=copy(applied);extra.balances=[];fail(()=>validateTradingConnectionCommandResult(extra,input.requestId,OWNER));
});

test('one preference per market or chain; a stale preference stays as stored and never becomes another record',()=>{
 for(const preferences of [[{key:'cex-spot',connectionId:'api-main'},{key:'cex-spot',connectionId:'api-denied'}],[{key:'spot',connectionId:'api-main'}],[{key:'dex-spot:10',connectionId:'wallet-arb'}],[{key:'cex-spot'}],[{key:'cex-spot',connectionId:'api-main',fallback:'api-denied'}],[{key:'cex-spot',connectionId:''}]])fail(()=>validateTradingConnectionState(state({preferences}),OWNER));
 const stored=[{key:'cex-perp',connectionId:'removed-connection'},{key:'dex-perp:42161',connectionId:'wallet-arb'}];
 assert.deepEqual(validateTradingConnectionState(state({preferences:copy(stored)}),OWNER).preferences,stored);
 for(const payload of [{key:'cex-margin',connectionId:'api-main'},{key:'cex-spot',connectionId:null},{key:'cex-spot'},{connectionId:'api-main'},{key:'cex-spot',connectionId:'api-main',fallback:'api-denied'}]){const input=copy(fixture.commands.prefer);input.payload=payload;fail(()=>validateTradingConnectionCommand(input),'PRIVATE_REQUEST_INVALID');}
 for(const action of ['approve','withdraw','trade','delete',undefined]){const input=copy(VERIFY);input.action=action;fail(()=>validateTradingConnectionCommand(input),'PRIVATE_REQUEST_INVALID');}
});

test('the browser view of saved connections fits the same record and save contract',()=>{
 const records=normalizeTradingConnections([
  {id:'api-main',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01',label:'Main'},
  {id:'api-perp',kind:'exchange',service:'okx',market:'perp',access:'read',accountId:'UNCONNECTED',label:'OKX perp'},
  {id:'wallet-arb',kind:'wallet',service:'metamask',chain:'42161',access:'confirm',accountId:'SIM-01',label:'Arbitrum wallet'},
  {id:'wallet-hl',kind:'wallet',service:'metamask',chain:'42161',venue:'hyperliquid',access:'read',accountId:'SIM-01',label:'HL wallet'},
  {id:'wallet-sol',kind:'wallet',service:'phantom',accountId:'SIM-01',label:'Solana wallet'}
 ]);
 const c={exchange:true,data:true,ai:true,preferences:normalizeConnectionPreferences(),tradingAccounts:records,preferredTradingConnection:''},a=new TradingAccess(c,{now:()=>NOW});
 a.configure(c,{section:'exchange',operation:'verify',connectionId:'api-main'});a.configure(c,{section:'wallet',operation:'verify',connectionId:'wallet-arb'});a.change('expire-connection','Arbitrum','wallet-arb');
 const connections=records.map(record=>{const view=a.contract(record.id);return {...view,checkCode:null,checkSource:view.checkedAt===null?null:'synthetic',credentialRef:null};});
 const value=validateTradingConnectionState({schema:'trading-connections-v1',scope:OWNER,revision:0,updatedAt:NOW,connections,preferences:[],executionAuthority:'NONE'},OWNER);
 assert.deepEqual(value.connections.map(item=>[item.connectionId,item.venueType,item.market,item.chain,item.status]),[['api-main','CEX','spot','','connected'],['api-perp','CEX','perp','','unchecked'],['wallet-arb','DEX','spot','42161','expired'],['wallet-hl','DEX','perp','42161','unchecked'],['wallet-sol','DEX','spot','solana:mainnet','unchecked']]);
 for(const record of records){
  const {connectionId,venue,venueType,market,chain,label,permissions}=a.contract(record.id);
  assert.equal(validateTradingConnectionCommand({requestId:'connection-save-0002',baseRevision:0,action:'save',payload:{connectionId,venue,venueType,market,chain,label,permissions}}).payload.connectionId,record.id);
 }
});

// A verify result for one record of the fixture state. As in verified(), the record takes the receipt's status,
// time, code and source. The record keeps the permissions it was saved with; the receipt carries the observed ones.
function checked(id,configured,observed,kind='connected'){
 const value=verified(kind),check={...copy(fixture.checks[kind]),connectionId:id,permissions:observed};
 value.state=withRecord(id,{permissions:configured,status:check.status,checkedAt:check.checkedAt,checkCode:check.code,checkSource:check.source});
 value.state.revision=value.request.revision;value.state.updatedAt=check.checkedAt;value.check=check;return value;
}

test('a connected verify result is refused when the record lists a permission that the receipt did not observe',()=>{
 for(const [id,configured,observed]of [['api-perp',['read','trade'],['read']],['api-main',['read','trade'],['read']],['api-perp',['read','trade'],['read','confirm']],['wallet-arb',['read','confirm'],['read']],['wallet-arb',['read','confirm'],['read','trade']]])fail(()=>validateTradingConnectionCommandResult(checked(id,configured,observed),VERIFY.requestId,OWNER));
});

test('a verify result passes when the receipt observed every permission the record lists, and only a connected result is held to it',()=>{
 for(const [id,configured,observed]of [['api-perp',['read'],['read']],['api-perp',['read','trade'],['read','trade']],['api-perp',['read','trade'],['trade','read']],['api-perp',['read'],['read','trade']],['api-main',['read','trade'],['read','trade']],['wallet-arb',['read','confirm'],['read','confirm']],['wallet-hl',['read'],['read','confirm']]]){const value=checked(id,configured,observed);assert.deepEqual(validateTradingConnectionCommandResult(copy(value),VERIFY.requestId,OWNER),value);}
 // A key that lacks a listed permission is answered with a result that is not connected, and that result passes.
 for(const [kind,observed]of [['permissions',['read']],['permissions',[]],['ip',['read']],['withdraw',['read','trade']],['timeout',[]],['unconfigured',[]]]){const value=checked('api-perp',['read','trade'],observed,kind);assert.deepEqual(validateTradingConnectionCommandResult(copy(value),VERIFY.requestId,OWNER),value);}
});

test('a receipt is connected only when read was observed',()=>{
 for(const permissions of [[],['trade'],['confirm'],['trade','confirm']])fail(()=>validateTradingConnectionCheck({...copy(fixture.checks.connected),permissions}));
});

test('a receipt that observed read connects whatever the order, and a receipt that did not connect may have observed nothing',()=>{
 for(const permissions of [['read'],['read','trade'],['trade','read'],['read','confirm'],['confirm','read']]){const value={...copy(fixture.checks.connected),permissions};assert.deepEqual(validateTradingConnectionCheck(copy(value)),value);}
 for(const kind of ['permissions','timeout','unconfigured']){assert.deepEqual(fixture.checks[kind].permissions,[]);assert.deepEqual(validateTradingConnectionCheck(copy(fixture.checks[kind])),fixture.checks[kind]);}
});
