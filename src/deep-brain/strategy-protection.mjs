// Local simulation companion. Source: Astarter Strategy and Risk Integration Plan v0.1,
// AST-R02–09. This does not implement or approve live H5 execution.
export const PROTECTION_VERSION='astarter-research-v0.1/sim-2';
export const PROTECTION_RULES=Object.freeze({episode:.0025,notional:.10,portfolio:.01,asset:.005,group:.006,event:.005,daily:.02,epoch:.05,soft:.03,hard:.08,reserve:.20});
export const PARAMETER_PROTECTION_VERSION='astarter-research-v0.1/sim-3';
export const PROTECTION_PARAMETER_KEYS=Object.freeze(['episode','notional','daily','epoch','soft','hard']);
export function protectionConfig(id='astarter',mode='normal',parameters){
 return id==='original'?{id:'original',version:'strategy-original'}:{id:'astarter',version:parameters===undefined?PROTECTION_VERSION:PARAMETER_PROTECTION_VERSION,mode:mode==='conservative'?'conservative':'normal',...(parameters===undefined?{}:{parameters:{...parameters}})};
}
export function protectionValid(p){
 if(!p||p.id==='original'&&p.version==='strategy-original')return true;
 if(p.id!=='astarter'||!['normal','conservative'].includes(p.mode))return false;
 if(p.version===PROTECTION_VERSION)return p.parameters===undefined;
 const r=p.parameters;
 return Boolean(p.version===PARAMETER_PROTECTION_VERSION&&r&&typeof r==='object'&&!Array.isArray(r)&&Object.keys(r).length===PROTECTION_PARAMETER_KEYS.length&&PROTECTION_PARAMETER_KEYS.every(key=>Object.hasOwn(r,key)&&Number.isFinite(r[key])&&r[key]>0&&r[key]<=PROTECTION_RULES[key])&&r.soft<r.hard);
}
export function protectionRules(policy){return policy?.version===PARAMETER_PROTECTION_VERSION&&protectionValid(policy)?{...PROTECTION_RULES,...policy.parameters}:PROTECTION_RULES;}
export function protectionKey(p){return JSON.stringify(p||protectionConfig('original'));}
export function newProtectionState(equity){return {base:equity,dayBase:equity,day:0,high:equity,lossDebit:0,reserve:0,settledHigh:equity,locked:null};}
export function advanceProtection(previous,{equity,settled=false,day=0,known=true,policy}){
 const s={...previous},rules=protectionRules(policy);
 if(policy?.id==='astarter'&&!protectionValid(policy))return {...s,locked:s.locked||'policy'};
 if(!known||!Number.isFinite(equity)||equity<=0)return {...s,locked:s.locked||'account'};
 // Ledger is fixed-capital in this prototype: no deposits, leverage, or withdrawals.
 s.high=Math.max(s.high,equity);
 s.lossDebit=Math.max(s.lossDebit,Math.max(0,s.base-equity));
 const dd=(s.high-equity)/s.high;
 if(!s.locked){if((s.dayBase-equity)/s.dayBase>=rules.daily-1e-10)s.locked='daily';else if(s.lossDebit>=s.base*rules.epoch-1e-8)s.locked='epoch';else if(dd>=rules.hard-1e-10)s.locked='drawdown';}
 if(day!==s.day){s.day=day;s.dayBase=equity;} // Day rollover never removes a lock.
 if(settled&&equity>s.settledHigh){s.reserve+=(equity-s.settledHigh)*rules.reserve;s.settledHigh=equity;}
 return s;
}
export function protectionDecision({policy,state,equity,requested,cap,cash,occupied={},pending=false,known=true,stopFraction,feeFraction=.002,asset='',strategyRisk=.0025}){
 if(policy?.id!=='astarter')return {amount:requested,action:'original',risk:0};
 const rules=protectionRules(policy);
 if(!protectionValid(policy)||!known||!state||!Number.isFinite(stopFraction)||stopFraction<=0)return {amount:0,action:'wait',reason:'account'};
 if(state.locked)return {amount:0,action:'pause',reason:state.locked};
 if(pending)return {amount:0,action:'wait',reason:'pending'};
 const E=Math.max(0,equity-state.reserve),dd=(state.high-equity)/state.high;
 const conservative=policy.mode==='conservative'||dd>=rules.soft;
 const multiplier=conservative?.5:1;
 const limits={episode:E*Math.min(rules.episode,strategyRisk)*multiplier,portfolio:E*rules.portfolio-(occupied.portfolio||0),asset:E*rules.asset-(occupied.asset||0),group:E*rules.group-(occupied.group||0),event:E*rules.event-(occupied.event||0),epoch:state.base*rules.epoch-state.lossDebit-(occupied.epoch||0)};
 const risk=Math.max(0,Math.min(...Object.values(limits)));
 const amount=Math.floor(Math.max(0,Math.min(requested,cap,E*rules.notional,(cash-state.reserve)/1.001,risk/(stopFraction+feeFraction)))*100)/100;
 return {amount:amount<5?0:amount,risk,limits,asset,conservative,action:amount<5?'pause':amount<requested?'reduce':'allow',reason:amount<5?'budget':null};
}

export function companionPreview(scene='normal',mode='normal'){
 let state=newProtectionState(10000),equity=10000;
 if(scene==='drawdown'){state.high=10500;equity=10164;}
 if(scene==='halt'){state.high=11000;equity=10120;}
 if(scene==='profit')equity=12000;
 state=advanceProtection(state,{equity,settled:scene==='profit'});
 const decision=protectionDecision({policy:protectionConfig('astarter',mode),state,equity,requested:1000,cap:1000,cash:equity,stopFraction:.02,pending:scene==='unknown',occupied:scene==='crowded'?{portfolio:55,asset:45,group:55}: {}});
 return {...decision,state,equity,scene};
}
