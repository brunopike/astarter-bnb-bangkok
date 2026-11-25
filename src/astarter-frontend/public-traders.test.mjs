import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicTraderRequest,validatePublicTraderBody} from './public-traders.mjs';

const first='0x'+'a'.repeat(40);
const second='0x'+'b'.repeat(40);
const params=value=>new URLSearchParams(value);
const now=1_800_000_000_000;

test('trader relay scopes address input to fixed public read-only types',()=>{
 for(const input of ['address=','address=0xabc','address='+first+'%0A','address='+first+'&address='+second,'type=exchange','window=week']) {
  assert.equal(publicTraderRequest(params(input)),null);
 }
 const profile=publicTraderRequest(params({address:'0x'+'A'.repeat(40)}));
 assert.equal(profile.key,'traders:'+first);
 assert.equal(profile.policy.parallel,true);
 assert.deepEqual(profile.policy.urls.map(source=>Boolean(source.optional)),[false,false,true]);
 assert.deepEqual(profile.policy.urls.map(source=>[source.url,source.method,JSON.parse(source.body)]),[
  ['https://api.hyperliquid.xyz/info','POST',{type:'portfolio',user:first}],
  ['https://api.hyperliquid.xyz/info','POST',{type:'clearinghouseState',user:first}],
  ['https://api.hyperliquid.xyz/info','POST',{type:'userFills',user:first}],
 ]);
});

test('leaderboard uses only period P&L and normalizes upstream ROI to percent',()=>{
 const row=(ethAddress,month)=>({ethAddress,accountValue:'10',displayName:'ignored',windowPerformances:[['day',{pnl:'99'}],['month',month]]});
 const request=publicTraderRequest(params());
 const result=request.decode([{leaderboardRows:[
  row(first,{pnl:'10',roi:'0.012',vlm:'246'}),
  row(second,{pnl:'-1',roi:'',vlm:null}),
  row('bad',{pnl:'20'}),
  row(first,{pnl:'11'}),
 ]}],now,now,[new Headers({'Last-Modified':new Date(now-1000).toUTCString()})]);
 assert.equal(result.sourceAsOf,now-1000);
 assert.equal(validatePublicTraderBody(result,null,now),true);
 assert.equal(validatePublicTraderBody({...result,rows:[{...result.rows[0],address:null},result.rows[1]]},null,now),false);
 assert.equal(result.window,'month');
 assert.equal(result.total,2);
 assert.deepEqual(result.rows,[
  {rank:1,address:first,pnl:10,accountValue:10,roiPct:1.2,volume:246},
  {rank:2,address:second,pnl:-1,accountValue:10,roiPct:null,volume:null},
 ]);
 assert.deepEqual(request.decode([{leaderboardRows:[]}]).rows,[]);
 assert.throws(()=>request.decode([{leaderboardRows:[row('bad',{pnl:'20'})]}]),/valid Hyperliquid/);
 assert.throws(()=>request.decode([null]),/Invalid Hyperliquid/);
});

const profile=publicTraderRequest(params({address:first}));
const portfolio=['day','week','month','allTime'].map(window=>[window,{
 vlm:'8',
 pnlHistory:[[now-1000,'2'],[now-30,'4.5']],
 accountValueHistory:[[now-1000,'17'],[now-20,'19.5']],
}]);
const snapshot={time:now-10,marginSummary:{accountValue:'19.5'},assetPositions:[]};

test('profile separates sampled portfolio P&L and actual current perpetual positions',()=>{
 const result=profile.decode([portfolio,{...snapshot,assetPositions:[
  {position:{coin:'ETH',szi:'-2',entryPx:'21',positionValue:'30',unrealizedPnl:'-1',returnOnEquity:'-0.02',leverage:{value:3}}},
  {position:{coin:'BTC',szi:'0'}},
 ]}],now);
 assert.equal(validatePublicTraderBody(result,first,now),true);
 assert.equal(validatePublicTraderBody(result,second,now),false);
 assert.equal(result.positionsAsOf,now-10);
 assert.equal(result.positionsScope,'default-perp-dex');
 assert.equal(result.perpAccountValue,19.5);
 assert.deepEqual(result.positions,[{symbol:'ETH',side:'short',size:2,entryPrice:21,positionValue:30,unrealizedPnl:-1,returnOnEquityPct:-2,leverage:3}]);
 assert.deepEqual(result.performance[0],{
  window:'day',from:now-1000,to:now-30,pnl:2.5,volume:8,
  pnlHistory:[[now-1000,2],[now-30,4.5]],accountValueHistory:[[now-1000,17],[now-20,19.5]],
 });
 assert.equal(Object.hasOwn(result.performance[0],'drawdown'),false);
});

test('actual empty positions and absent samples are distinct from invalid upstream replies',()=>{
 const empty=portfolio.map(([window])=>[window,{pnlHistory:[],accountValueHistory:[],vlm:'0'}]);
 const result=profile.decode([empty,snapshot],now);
 assert.deepEqual(result.positions,[]);
 assert.equal(result.performance[0].pnl,null);
 assert.equal(result.performance[0].volume,0);
 assert.throws(()=>profile.decode([null,snapshot],now),/Invalid Hyperliquid portfolio/);
 assert.throws(()=>profile.decode([portfolio,{...snapshot,time:now+120000}],now),/Invalid Hyperliquid positions/);
 assert.throws(()=>profile.decode([portfolio,{...snapshot,assetPositions:[{position:{coin:'BTC',szi:null}}]}],now),/Invalid Hyperliquid position/);
 assert.throws(()=>profile.decode([portfolio.map(([window,data])=>[window,{...data,pnlHistory:[...data.pnlHistory].reverse()}]),snapshot],now),/Invalid Hyperliquid portfolio history/);
});


test('profile returns latest distinct public fills and preserves asset identifiers and source timestamps',()=>{
 const fills=Array.from({length:30},(_,i)=>({coin:i===29?'@107':'xyz:XYZ100',px:'4.1',sz:'2.5',side:i===29?'A':'B',time:now-i,tid:30-i}));
 fills[29].time=now;
 fills.push({coin:'PURR/USDC',px:'0.09',sz:'1',side:'A',time:now,tid:0,dir:'Spot Dust Conversion'});
 const result=profile.decode([portfolio,snapshot,[...fills].reverse()],now);
 assert.equal(validatePublicTraderBody(result,first,now),true);
 assert.equal(result.fills.length,25);
 assert.deepEqual(result.fills.slice(0,2),[
  {id:'30',symbol:'xyz:XYZ100',side:'buy',time:now,price:4.1,size:2.5},
  {id:'1',symbol:'@107',side:'sell',time:now,price:4.1,size:2.5},
 ]);
 assert.equal(validatePublicTraderBody({...result,fills:[result.fills[0],result.fills[0]]},first,now),false);
 assert.equal(validatePublicTraderBody({...result,fills:[{...result.fills[0],time:now+120_000}]},first,now),false);
});

test('failed or invalid fills leave the profile available and differ from verified empty fills',()=>{
 for(const fills of [null,[{coin:'BTC',px:'1',sz:'1',side:'A',time:now,tid:0}],[{coin:'BTC',px:'1',sz:'1',side:'B',time:now+120_000,tid:1}]]) {
  const result=profile.decode([portfolio,snapshot,fills],now);
  assert.equal(result.fills,null);
  assert.equal(result.positionsAsOf,snapshot.time);
  assert.equal(result.performance[0].pnl,2.5);
 }
 assert.deepEqual(profile.decode([portfolio,snapshot,[]],now).fills,[]);
});
