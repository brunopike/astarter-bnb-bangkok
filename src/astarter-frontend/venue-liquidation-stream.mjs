import {DERIVATIVE_SYMBOLS} from './public-market-extended.mjs';

const hosts={binance:'wss://fstream.binance.com/market/stream',bybit:'wss://stream.bybit.com/v5/public/linear'};
const positive=v=>typeof v==='string'&&v.length<=36&&/^\d+(?:\.\d+)?$/.test(v)&&Number(v)>0;
const sources=Object.keys(hosts);

export function liquidationUpdates(venue, symbol, message, startedAt, now){
 const pair=symbol+'USDT',binance=venue==='binance';
 if(!DERIVATIVE_SYMBOLS.includes(symbol)||!sources.includes(venue)||!message)return [];
 let entries;
 if(binance){
  if(message.stream!==pair.toLowerCase()+'@forceOrder'||message.data?.e!=='forceOrder')return [];
  entries=[message.data.o];
 }else{
  if(message.topic!=='allLiquidation.'+pair||message.type!=='snapshot'||!Array.isArray(message.data)||message.data.length>500)return [];
  entries=message.data;
 }
 const result=[],occurrences=new Map();
 for(const e of entries){
  if(e?.s!==pair||!Number.isSafeInteger(e.T)||e.T<startedAt||e.T>now+5000)continue;
  const size=binance?e.z:e.v,price=binance?e.ap:e.p;
  if(!positive(size)||!positive(price)||!Number.isFinite(Number(size)*Number(price)))continue;
  if(binance&&(!['FILLED','PARTIALLY_FILLED','EXPIRED'].includes(e.X)||!['SELL','BUY'].includes(e.S)))continue;
  if(!binance&&!['Buy','Sell'].includes(e.S))continue;
  const position=(binance?e.S==='SELL':e.S==='Buy')?'long':'short';
  const key=[venue,e.T,position,Number(size),Number(price)].join(':');
  // Bybit can bundle two indistinguishable fills in a single snapshot; retain their multiplicity on replay.
  const index=occurrences.get(key)||0;occurrences.set(key,index+1);
  result.push({key:key+':'+index,venue,at:e.T,position,size:Number(size),price:Number(price),amount:Number(size)*Number(price)});
 }
 return result;
}

export function createLiquidationTape(symbol,onChange,{now=Date.now,WebSocketImpl=globalThis.WebSocket}={}){
 if(!DERIVATIVE_SYMBOLS.includes(symbol))throw Error('UNSUPPORTED_LIQUIDATION_SYMBOL');
 const startedAt=now(),events=[],slots=sources.map(venue=>({venue,status:'connecting',socket:null,failures:0,retryAt:0,pingAt:0,pingSent:0}));
 const pair=symbol+'USDT',binanceTopic=pair.toLowerCase()+'@forceOrder',bybitTopic='allLiquidation.'+pair;
 let disposed=false;
 function close(slot){
  const socket=slot.socket;slot.socket=null;if(!socket)return;
  socket.onopen=socket.onmessage=socket.onclose=socket.onerror=null;
  try{socket.close();}catch{}
 }
 function fail(slot){
  close(slot);slot.status='disconnected';
  slot.retryAt=now()+Math.min(60000,3000*2**Math.min(slot.failures++,5));onChange();
 }
 function connect(slot){
  const binance=slot.venue==='binance';
  slot.status='connecting';slot.openedAt=now();slot.pingSent=0;
  try{
   const socket=new WebSocketImpl(hosts[slot.venue]);slot.socket=socket;
   const active=()=>!disposed&&slot.socket===socket;
   socket.onclose=socket.onerror=()=>{if(active())fail(slot);};
   socket.onopen=()=>{
    if(!active())return;
    try{socket.send(JSON.stringify(binance?{method:'SUBSCRIBE',params:[binanceTopic],id:'subscribe'}:{op:'subscribe',args:[bybitTopic],req_id:'subscribe'}));}catch{fail(slot);}
   };
   socket.onmessage=event=>{
    if(!active()||typeof event.data!=='string'||event.data.length>180000)return;
    let m;try{m=JSON.parse(event.data);}catch{return;}
    if(!m||typeof m!=='object')return;
    if(m.code!==undefined||m.success===false){fail(slot);return;}
    const ack=binance?m.id==='subscribe'&&m.result===null:m.op==='subscribe'&&m.req_id==='subscribe'&&m.success===true;
    if(ack&&slot.status==='connecting'){
     slot.status='live';slot.pingAt=now()+20000;onChange();return;
    }
    if(binance&&m.id==='heartbeat'&&Array.isArray(m.result)){
     if(!m.result.includes(binanceTopic)){fail(slot);return;}
     slot.pingSent=0;slot.failures=0;return;
    }
    if(!binance&&(m.op==='pong'||m.op==='ping'&&m.ret_msg==='pong')&&m.success!==false){slot.pingSent=0;slot.failures=0;return;}
    const updates=liquidationUpdates(slot.venue,symbol,m,startedAt,now());
    if(!updates.length)return;
    // A venue can send its first subscribed event before the acknowledgment.
    if(slot.status==='connecting'){slot.status='live';slot.pingAt=now()+20000;}
    const known=new Set(events.map(e=>e.key));
    const fresh=updates.filter(e=>!known.has(e.key));if(!fresh.length)return;
    events.push(...fresh);events.sort((a,b)=>b.at-a.at);events.splice(25);onChange();
   };
  }catch{fail(slot);}
 }
 return {startedAt,events,slots,
  tick(){
   if(disposed)return;
   const time=now();
   for(const slot of slots){
    if(!slot.socket){if(time>=slot.retryAt){connect(slot);onChange();}continue;}
    if(slot.status==='connecting'&&time-slot.openedAt>=15000||slot.pingSent&&time-slot.pingSent>=12000){fail(slot);continue;}
    if(slot.status==='live'&&!slot.pingSent&&time>=slot.pingAt){
     slot.pingSent=time;slot.pingAt=time+20000;
     try{slot.socket.send(JSON.stringify(slot.venue==='binance'?{method:'LIST_SUBSCRIPTIONS',id:'heartbeat'}:{op:'ping',req_id:'heartbeat'}));}catch{fail(slot);}
    }
   }
  },
  dispose(){disposed=true;for(const slot of slots)close(slot);}
 };
}
