import assert from 'node:assert/strict';
import test from 'node:test';
import {acceptedSources,marketTypeOf,redactMemoryText,strategyMemoryContext,userKey} from './living-brain.mjs';

test('user key is not the wallet address',()=>{
 const address='0x1111111111111111111111111111111111111111';
 const key=userKey(address);
 assert.equal(key.length,16);
 assert.doesNotMatch(key,/0x/i);
 assert.equal(userKey(address),userKey(address.toUpperCase()));
});

test('memory text drops keys, wallets and long order ids',()=>{
 const clean=redactMemoryText('lbk_secret 0x2222222222222222222222222222222222222222 order 68871608690');
 assert.equal(clean.includes('lbk_'),false);
 assert.equal(clean.includes('0x2222'),false);
 assert.equal(clean.includes('68871608690'),false);
});

test('market type keeps the saved outlet',()=>{
 assert.equal(marketTypeOf('cex-perp','BTC/USDT'),'cex-perp');
 assert.equal(marketTypeOf('','SPX'),'tradfi');
 assert.equal(marketTypeOf('wallet','BTC/USDT'),'');
});

test('context finds older original sources beyond the first page and rechecks the saved IDs',async()=>{
 const user={key:'scope-owner'},origin='user:scope-owner:',suffix='S00:new:test:2';
 const planSource=(id,ref,strategy='S00',market='cex-spot')=>({id,originRef:ref,status:'completed',content:`策略编号: ${strategy}\n市场类型: ${market}\n交易平台: binance\n交易标的: BTC/USDT\n金额: 11\n上限: 37\n参数名: fast, slow`});
 const plan=planSource('plan',origin+'plan:'+suffix);
 const decision={id:'decision',originRef:origin+'decision:'+suffix,status:'compiling',content:'改了什么: 金额 11；上限 37；参数 fast, slow\n为什么: 保存在 cex-spot binance BTC/USDT\n否决了什么: 没有发送交易所订单'};
 const other=planSource('another-user','user:stranger:plan:'+suffix);
 const wrong=planSource('another-strategy',origin+'plan:opaque:2','S01');
 const conflict={...plan,id:'conflict',content:plan.content+'\noriginRef: '+other.originRef};
 const rows=[...Array.from({length:100},(_,i)=>({...other,id:'foreign-'+i})),wrong,conflict,planSource('wrong-market',origin+'plan:another-market:2','S00','dex-spot'),
  {...decision,id:'orphan',originRef:origin+'decision:opaque:2'},plan,decision,
  {id:'rule',originRef:'strategy:S00',status:'completed',content:'Shared rule'},
  {id:'other-rule',originRef:'strategy:S01',status:'completed',content:'Other rule'},
  {id:'lesson',originRef:'lesson:S00:cex-spot:test',status:'completed',content:'Shared lesson'},
  {id:'other-lesson',originRef:'lesson:S01:cex-spot:test',status:'completed',content:'Other lesson'}];
 const calls=[];
 const client=async pathname=>{
  const url=new URL(pathname,'https://test.invalid');
  assert.match(url.pathname,/\/sources$/);
  calls.push(url.searchParams);
  const ids=url.searchParams.get('ids')?.split(',');
  const offset=Number(url.searchParams.get('offset'));
  return {items:ids?rows.filter(row=>ids.includes(row.id)):rows.slice(offset,offset+100),total:rows.length};
 };
 const context=await strategyMemoryContext(user,'S00','cex-spot',client);
 assert.deepEqual(calls.map(params=>params.get('offset')),['0','100']);
 assert.deepEqual(context.rules.map(row=>row.sourceId),['rule']);
 assert.deepEqual(context.lessons.map(row=>row.sourceId),['lesson']);
 assert.deepEqual(context.choices.map(row=>row.sourceId),['plan','decision']);
 assert.deepEqual(context.choices[0].plan,{venue:'binance',instrument:'BTC/USDT',amount:'11',cap:'37',parameters:'fast, slow'});
 assert.equal(context.choices[1].decision.standard,true);
 assert.equal(context.choices[1].status,'compiling');
 decision.status='completed';
 const again=await strategyMemoryContext(user,'S00','cex-spot',client);
 assert.deepEqual(new Set(calls.at(-1).get('ids').split(',')),new Set(['plan','decision','rule','lesson']));
 assert.equal(again.choices[1].status,'completed');
 plan.originRef=other.originRef;
 assert.equal((await strategyMemoryContext(user,'S00','cex-spot',client)).choices.length,0);
 await assert.rejects(()=>strategyMemoryContext(user,'S00','cex-spot',()=>Promise.reject(Error('offline'))),/offline/);
});

test('a batch acknowledges this version only when both original captures match',()=>{
 const items=[{originRef:'plan:version',content:'amount 11'},{originRef:'decision:version',content:'keep cap 37'}];
 const sources=items.map((item,i)=>({...item,id:String(i+1),status:i?'compiling':'pending'}));
 assert.deepEqual(acceptedSources(items,{ingested:2,sources:[...sources].reverse()}),sources);
 for(const altered of [
  sources.slice(0,1),[sources[0],sources[0]],
  [sources[0],{...sources[1],id:sources[0].id}],
  [sources[0],{...sources[1],originRef:'other-owner'}],
  [sources[0],{...sources[1],content:'old version'}],
  [sources[0],{...sources[1],status:'failed'}]
 ])assert.equal(acceptedSources(items,{ingested:2,sources:altered}),null);
});

test('an incomplete or repeated source page reports an error without looping',async()=>{
 for(const items of [[],[{id:'same'}]]){
  let calls=0;
  const client=async(_path,{signal})=>{
   assert.ok(signal instanceof AbortSignal);
   assert.ok(++calls<=2);
   return {total:9,items};
  };
  await assert.rejects(()=>strategyMemoryContext({key:'broken-pages'},'S00','cex-spot',client),/source-(list|pagination)/);
 }
});
