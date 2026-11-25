const venue = {source:'Hyperliquid',network:'mainnet',currency:'USD'};
const leaderboard = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const info = 'https://api.hyperliquid.xyz/info';
const addressPattern = /^0x[0-9a-fA-F]{40}$/u;
const windows = ['day','week','month','allTime'];
const symbolPattern = /^[A-Za-z0-9@._:/-]{1,40}$/u;
const fillLimit = 25;

function number(value) {
 if(typeof value==='string'&&/^-?\d+(?:\.\d+)?$/u.test(value))value=Number(value);
 return Number.isFinite(value)?value:null;
}

function percent(value) {
 const ratio=number(value);
 return ratio===null?null:number(ratio*100);
}

function address(value) {
 return typeof value==='string'&&value.length===42&&addressPattern.test(value)?value.toLowerCase():null;
}

function tupleValue(list,key) {
 return Array.isArray(list)?list.find(pair=>Array.isArray(pair)&&pair[0]===key)?.[1]:undefined;
}

function decodeLeaderboard(body,receivedAt,lastModified) {
 if(!Array.isArray(body?.leaderboardRows))throw new Error('Invalid Hyperliquid leaderboard');
 const accounts=new Map();
 for(const row of body.leaderboardRows) {
  const id=address(row?.ethAddress);
  const month=tupleValue(row?.windowPerformances,'month');
  const pnl=number(month?.pnl);
  if(!id||pnl===null||accounts.has(id))continue;
  accounts.set(id,{address:id,pnl,accountValue:number(row.accountValue),roiPct:percent(month.roi),volume:number(month.vlm)});
 }
 if(body.leaderboardRows.length&&!accounts.size)throw new Error('No valid Hyperliquid leaderboard rows');
 const rows=[...accounts.values()].sort((a,b)=>b.pnl-a.pnl||a.address.localeCompare(b.address));
 const sourceTimestamp=Date.parse(lastModified);
 const sourceAsOf=timestamp(sourceTimestamp,receivedAt)?sourceTimestamp:null;
 return {...venue,kind:'leaderboard',window:'month',ranking:'pnl',sourceAsOf,total:rows.length,rows:rows.slice(0,50).map((row,i)=>({rank:i+1,...row}))};
}

function timestamp(value,receivedAt) {
 return Number.isSafeInteger(value)&&value>0&&value<=receivedAt+60_000;
}

function history(points,receivedAt) {
 if(!Array.isArray(points))return null;
 const result=[];
 for(const point of points) {
  if(!Array.isArray(point)||point.length!==2)return null;
  const [time,raw]=point;
  const amount=number(raw);
  if(!timestamp(time,receivedAt)||amount===null||time<(result.at(-1)?.[0]??0))return null;
  result.push([time,amount]);
 }
 return result;
}

function decodePerformance(portfolio,receivedAt) {
 if(!Array.isArray(portfolio))throw new Error('Invalid Hyperliquid portfolio');
 const performance=[];
 for(const window of windows) {
  const record=tupleValue(portfolio,window);
  const pnlHistory=history(record?.pnlHistory,receivedAt);
  const accountValueHistory=history(record?.accountValueHistory,receivedAt);
  if(!pnlHistory||!accountValueHistory)throw new Error('Invalid Hyperliquid portfolio history');
  const from=pnlHistory.at(0)?.[0]??null;
  const to=pnlHistory.at(-1)?.[0]??null;
  const pnl=from!==null&&to>from?number(pnlHistory.at(-1)[1]-pnlHistory[0][1]):null;
  performance.push({window,from,to,pnl,volume:number(record.vlm),pnlHistory,accountValueHistory});
 }
 return performance;
}

function decodePosition(raw) {
 const size=number(raw?.szi);
 if(size===null||typeof raw.coin!=='string'||!symbolPattern.test(raw.coin))throw new Error('Invalid Hyperliquid position');
 if(!size)return null;
 return {
  symbol:raw.coin,
  side:size>0?'long':'short',
  size:Math.abs(size),
  entryPrice:number(raw.entryPx),
  positionValue:number(raw.positionValue),
  unrealizedPnl:number(raw.unrealizedPnl),
  returnOnEquityPct:percent(raw.returnOnEquity),
  leverage:number(raw.leverage?.value),
 };
}

function decodeFills(raw,receivedAt) {
 if(!Array.isArray(raw)||raw.length>2000)return null;
 const fills=new Map();
 for(const item of raw) {
  // Spot dust conversion appears in this feed without an executed trade ID.
  if(item?.tid===0&&item.dir==='Spot Dust Conversion')continue;
  const price=number(item?.px);
  const size=number(item?.sz);
  if(!(price>0&&size>0)||!timestamp(item.time,receivedAt)||typeof item.coin!=='string'||!symbolPattern.test(item.coin)||
     !Number.isSafeInteger(item.tid)||item.tid<=0||!['B','A'].includes(item.side))return null;
  const id=String(item.tid);
  fills.set(id,{id,symbol:item.coin,side:item.side==='B'?'buy':'sell',time:item.time,price,size});
 }
 return [...fills.values()].sort((a,b)=>b.time-a.time||Number(b.id)-Number(a.id)).slice(0,fillLimit);
}

function decodeProfile(user,[portfolio,state,fills],receivedAt) {
 if(!Array.isArray(state?.assetPositions)||!timestamp(state.time,receivedAt))throw new Error('Invalid Hyperliquid positions snapshot');
 const positions=state.assetPositions.map(item=>decodePosition(item?.position)).filter(Boolean);
 return {
  ...venue,kind:'profile',address:user,
  performance:decodePerformance(portfolio,receivedAt),
  positions,positionsAsOf:state.time,positionsScope:'default-perp-dex',
  perpAccountValue:number(state.marginSummary?.accountValue),fills:decodeFills(fills,receivedAt),
 };
}

export function publicTraderRequest(params) {
 const addresses=params.getAll('address');
 if([...params.keys()].some(key=>key!=='address')||addresses.length>1)return null;
 if(!addresses.length) {
  return {
   key:'traders',resource:'traders',
   policy:{url:leaderboard,interval:900_000,stale:3_600_000,maxBytes:50_000_000},
   decode:([body],receivedAt,_startedAt,headers)=>decodeLeaderboard(body,receivedAt,headers?.[0]?.get('Last-Modified')),
  };
 }
 const user=address(addresses[0]);
 if(!user)return null;
 const urls=['portfolio','clearinghouseState','userFills'].map(type=>({
  url:info,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,user}),
  ...(type==='userFills'?{optional:true}:{}),
 }));
 return {
  key:'traders:'+user,resource:'traders',
  policy:{urls,parallel:true,interval:30_000,stale:300_000,maxBytes:1_000_000},
  decode:(parts,receivedAt)=>decodeProfile(user,parts,receivedAt),
 };
}

const nullableNumber=value=>value===null||Number.isFinite(value);

function validFills(fills,receivedAt) {
 if(fills===null)return true;
 if(!Array.isArray(fills)||fills.length>fillLimit)return false;
 const ids=new Set();
 let lastTime=receivedAt+60_000;
 for(const item of fills) {
  if(!item||typeof item.id!=='string'||!/^\d+$/u.test(item.id)||!Number.isSafeInteger(Number(item.id))||
     Number(item.id)<=0||String(Number(item.id))!==item.id||ids.has(item.id)||!timestamp(item.time,receivedAt)||item.time>lastTime||
     typeof item.symbol!=='string'||!symbolPattern.test(item.symbol)||!['buy','sell'].includes(item.side)||
     !Number.isFinite(item.price)||item.price<=0||!Number.isFinite(item.size)||item.size<=0)return false;
  ids.add(item.id);
  lastTime=item.time;
 }
 return true;
}

export function validatePublicTraderBody(body,expectedAddress,receivedAt) {
 if(!Number.isSafeInteger(receivedAt)||receivedAt<=0||!body||Object.keys(venue).some(key=>body[key]!==venue[key]))return false;
 if(expectedAddress===null||expectedAddress===undefined) {
  if(body.kind!=='leaderboard'||body.window!=='month'||body.ranking!=='pnl'||!Number.isSafeInteger(body.total)||body.total<0||
    !(body.sourceAsOf===null||timestamp(body.sourceAsOf,receivedAt))||!Array.isArray(body.rows)||body.rows.length!==Math.min(body.total,50))return false;
  return body.rows.every((row,i)=>row&&row.rank===i+1&&typeof row.address==='string'&&address(row.address)===row.address&&
   Number.isFinite(row.pnl)&&[row.accountValue,row.roiPct,row.volume].every(nullableNumber));
 }
 if(!address(expectedAddress)||body.kind!=='profile'||body.address!==address(expectedAddress)||
   body.positionsScope!=='default-perp-dex'||!timestamp(body.positionsAsOf,receivedAt)||!nullableNumber(body.perpAccountValue)||
   !Array.isArray(body.performance)||body.performance.length!==windows.length||!Array.isArray(body.positions)||!validFills(body.fills,receivedAt))return false;
 return body.performance.every((item,i)=>item&&item.window===windows[i]&&history(item.pnlHistory,receivedAt)&&
   history(item.accountValueHistory,receivedAt)&&item.pnlHistory.every(point=>Number.isFinite(point[1]))&&
   item.accountValueHistory.every(point=>Number.isFinite(point[1]))&&item.from===(item.pnlHistory[0]?.[0]??null)&&
   item.to===(item.pnlHistory.at(-1)?.[0]??null)&&nullableNumber(item.pnl)&&nullableNumber(item.volume))&&
  body.positions.every(item=>item&&typeof item.symbol==='string'&&symbolPattern.test(item.symbol)&&
   ['long','short'].includes(item.side)&&Number.isFinite(item.size)&&item.size>0&&
   [item.entryPrice,item.positionValue,item.unrealizedPnl,item.returnOnEquityPct,item.leverage].every(nullableNumber));
}
