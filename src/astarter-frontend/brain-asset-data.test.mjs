import test from 'node:test';
import ranking from './brain-evidence/market-cap-top20.json' with {type:'json'};
import assert from 'node:assert/strict';
import {brainAssetKey,brainCatalog,fetchBrainRanking,canonicalBrainScope,filterBrainCatalog,readSavedBrainAsset,preferBrainEvidence,loadBrainCatalog,refreshBrainAsset,refreshBrainCatalog,searchBrainAssets} from './brain-asset-data.mjs';

const response = value => ({ok:true,text:async()=>JSON.stringify(value)});
const unavailable = async()=>{throw new Error('offline');};
const address='0x'+'A1'.repeat(20);
const move='0x000a::wrapped::wBTC';
const ton='EQB'+'Ab1_'.repeat(11)+'z';
const pair=(chain,ca,liq=123,price='1.25')=>({
  chainId:chain,dexId:'test-dex',pairAddress:'pool-test',
  baseToken:{address:ca,name:'Wrapped asset',symbol:'BTC'},priceUsd:price,
  priceChange:{h24:-2.1},volume:{h24:0},liquidity:{usd:liq},
});
const markets=(id,at)=>[{
  id,symbol:'btc',name:'Bitcoin',current_price:123.5,market_cap:1500,
  total_volume:89,price_change_percentage_24h:-1.5,last_updated:at,
}];

test('bundled snapshot covers native networks and identified pools with real provenance',async()=>{
  const rows=await loadBrainCatalog();
  assert.notEqual(rows,brainCatalog);assert.equal(new Set(rows.map(brainAssetKey)).size,rows.length);
  for(const chain of ['bitcoin','ethereum','bsc','solana','base','arbitrum','sui','ton'])assert(rows.some(a=>a.chain===chain));
  for(const a of rows){
    assert(a.price>0 && Number.isFinite(Date.parse(a.receivedAt)));
    assert.match(a.sourceUrl,/^https:\/\/(?:www\.coingecko\.com|dexscreener\.com)\//);
    if(a.provider==='CoinGecko'){assert.equal(a.address,null);assert(a.asOf);assert.equal(a.liquidity,null);}
    else{assert.equal(a.asOf,null);assert(a.venue && a.liquidity>0);}
  }
});

test('a refreshed market snapshot carries its own seven-day sample through selection and restoration',async()=>{
  const asset=brainCatalog.find(row=>row.id==='bitcoin');
  const at=new Date().toISOString();
  const sample=[123.2,119.7,123.5];
  const fetchImpl=async()=>response(markets('bitcoin',at).map(row=>({...row,sparkline_in_7d:{price:sample}})));
  const updated=await refreshBrainAsset(asset,{fetchImpl});
  assert.deepEqual(updated.series,sample);
  assert.deepEqual(readSavedBrainAsset(JSON.parse(JSON.stringify(updated))).series,sample);
  assert.equal(preferBrainEvidence({...updated,series:[]},updated),updated);
  assert.equal(preferBrainEvidence(updated,{...updated,series:[...sample]}),updated);
  assert.deepEqual(readSavedBrainAsset({...updated,series:[123,null,125]}).series,[]);
});

test('address identities retain chain, Move type and case-sensitive non-EVM suffixes',()=>{
  assert.equal(brainAssetKey({id:'bitcoin',chain:'bitcoin'}),'coin:bitcoin');
  assert.equal(brainAssetKey({chain:'base',address}),'ca:base:'+address.toLowerCase());
  assert.notEqual(brainAssetKey({chain:'base',address}),brainAssetKey({chain:'arbitrum',address}));
  assert.equal(brainAssetKey({chain:'sui',address:move}),'ca:sui:0xa::wrapped::wBTC');
  assert.notEqual(brainAssetKey({chain:'sui',address:move}),brainAssetKey({chain:'sui',address:move.toLowerCase()}));
  assert.equal(brainAssetKey({chain:'ton',address:ton}),'ca:ton:'+ton);
  assert.equal(brainAssetKey({chain:'bad chain',address}),'');
});

test('the picker and shared links preserve chain-specific address casing for cached assets',()=>{
  const tokens=[['ton',ton],['solana','Az'.repeat(22)],['sui',move],['base',address]].map(([chain,id])=>({
    chain,address:id,symbol:'TOKEN',name:'Token',id:brainAssetKey({chain,address:id}),
  }));
  for(const row of tokens){
    const original='ca:'+row.chain+':'+row.address;
    assert.equal(canonicalBrainScope(original),brainAssetKey(row));
    assert.deepEqual(filterBrainCatalog(tokens,original),[row]);
    assert.deepEqual(filterBrainCatalog(tokens,row.address),[row]);
    const folded=row.chain==='base'?[row]:[];
    assert.deepEqual(filterBrainCatalog(tokens,original.toLowerCase()),folded);
    assert.deepEqual(filterBrainCatalog(tokens,row.address.toLowerCase()),folded);
  }
  assert.deepEqual(filterBrainCatalog(tokens,'toKen'),tokens);
  assert.equal(canonicalBrainScope('coin:bitcoin'),'coin:bitcoin');
});

test('remote text search retains distinct same-symbol identities, custom chains and the most liquid base-token pool',async()=>{
  const data=[pair('unlisted-mainnet',address,0),pair('unlisted-mainnet',address,230,'2'),pair('solana','S'.repeat(44),3)];
  const calls=[];
  const rows=await searchBrainAssets('BTC',{fetchImpl:async url=>{
    calls.push(url);
    return response(url.includes('dexscreener')?{pairs:data}:{coins:[{id:'sample-btc',name:'Another BTC',symbol:'btc'}]});
  }});
  assert(calls.some(u=>u.includes('dexscreener'))&&calls.some(u=>u.includes('coingecko')));
  assert(rows.some(a=>brainAssetKey(a)==='coin:bitcoin'&&a.kind==='native'));
  assert(rows.some(a=>a.id==='sample-btc'&&a.chain===null&&a.price===null&&a.kind==='market'));
  const d=rows.filter(a=>a.chain==='unlisted-mainnet');assert.equal(d.length,1);
  assert.equal(d[0].kind,'contract');assert.equal(d[0].price,2);assert.equal(d[0].change,-2.1);
  assert.equal(d[0].volume,0);assert.equal(d[0].asOf,null);
});

test('exact-address searches preserve TON, Move and Solana identities and exclude unrelated pairs',async()=>{
  for(const [chain,ca] of [['sui',move],['ton',ton],['solana','Az'.repeat(22)]]){
    const calls=[], values=[pair(chain,ca),pair(chain,ca.toLowerCase()),pair('other',ca)];
    const rows=await searchBrainAssets('ca:'+chain+':'+ca,{fetchImpl:async u=>{calls.push(u);return response(values);}});
    assert.equal(rows.length,1);assert.equal(rows[0].address,ca);assert.equal(calls.length,1);
    assert(calls[0].includes('/token-pairs/v1/'+chain+'/'));
  }
  const rows=await searchBrainAssets('0x'+'Z'.repeat(40),{fetchImpl:async()=>assert.fail('Malformed address should have no request')});
  assert.deepEqual(rows,[]);
});

test('offline search and refresh preserve source times, nullable fields and exact asset identity',async()=>{
  const local=brainCatalog.find(a=>a.id==='bitcoin');
  assert((await searchBrainAssets('BTC',{fetchImpl:unavailable})).includes(local));
  assert.equal(await refreshBrainAsset(local,{fetchImpl:unavailable}),local);
  const arb=brainCatalog.find(a=>a.chain==='arbitrum');
  assert.equal(await refreshBrainAsset(arb,{fetchImpl:async()=>response([pair('base',arb.address)])}),arb);
  const old=Date.parse(local.asOf)-60000;
  assert.equal(await refreshBrainAsset(local,{fetchImpl:async()=>response(markets('bitcoin',new Date(old).toISOString()))}),local);
});

test('refresh uses source update time for aggregated prices, receipt time only for DEX and never coalesces nulls with zero',async()=>{
  const fresh=new Date(Date.now()-1000).toISOString();
  const coin={...brainCatalog.find(a=>a.id==='bitcoin'),asOf:'2020-01-01T00:00:00.000Z'};
  const result=await refreshBrainAsset(coin,{fetchImpl:async()=>response(markets(coin.id,fresh))});
  assert.equal(result.asOf,fresh);assert.equal(result.price,123.5);assert.equal(result.liquidity,null);
  const row=brainCatalog.find(a=>a.chain==='base');
  const proof=pair('base',row.address);delete proof.priceChange;delete proof.liquidity;proof.pairCreatedAt=Date.now();
  const contract=await refreshBrainAsset(row,{fetchImpl:async()=>response([proof])});
  assert.equal(contract.asOf,null);assert.equal(contract.change,null);assert.equal(contract.liquidity,null);assert.equal(contract.volume,0);
  assert(Number.isFinite(Date.parse(contract.receivedAt)));
});

test('caller cancellation remains observable for search, loading and refresh',async()=>{
  const signal=AbortSignal.abort();
  for(const fn of [()=>loadBrainCatalog({signal}),()=>searchBrainAssets('SOL',{signal}),()=>refreshBrainAsset(brainCatalog[0],{signal})]) await assert.rejects(fn,{name:'AbortError'});
});

test('USDC symbol results include issuer-matched contracts and quote-side identities without inventing prices',async()=>{
  const quoteAddress='0x'+'2e'.repeat(20);
  const unrelated=pair('polygon',address,9e9,'56900');
  unrelated.baseToken={address,symbol:'WBTC',name:'Wrapped Bitcoin'};
  unrelated.quoteToken={address:quoteAddress,symbol:'USDC',name:'USD Coin'};
  const prefix=pair('arbitrum',address);prefix.baseToken={address,symbol:'DEPOSIT',name:'USDC Vault Deposit'};
  const rows=await searchBrainAssets('USDC',{fetchImpl:async url=>response(url.includes('dexscreener')
    ?{pairs:[prefix,unrelated]}:{coins:[{id:'usd-coin',name:'USD Coin',symbol:'usdc'}]})});
  assert(!rows.some(a=>a.symbol==='WBTC'));
  const requested=rows.find(a=>a.address===quoteAddress);
  assert(requested && requested.price===null && requested.change===null && requested.volume===null && requested.liquidity===null);
  assert(rows.find(a=>a.address==='0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'));
  assert(rows.find(a=>a.address==='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'));
  assert.equal(rows.at(-1).symbol,'DEPOSIT');
  const byAddress=await searchBrainAssets('ca:polygon:'+quoteAddress,{fetchImpl:async()=>response([unrelated])});
  assert.equal(byAddress.length,1);assert.equal(byAddress[0].address,quoteAddress);assert.equal(byAddress[0].price,null);
  const verified=await refreshBrainAsset({...requested,price:1,receivedAt:'2025-01-01T00:00:00Z'},{fetchImpl:async()=>response([unrelated])});
  assert.equal(verified.price,1);assert.equal(verified.receivedAt,'2025-01-01T00:00:00Z');
});

test('registry outages differ from an authoritative empty search and never replace a bundled result',async()=>{
  await assert.rejects(searchBrainAssets('nosuch-token',{fetchImpl:unavailable}),/BRAIN_ASSET_SEARCH_UNAVAILABLE/);
  await assert.rejects(searchBrainAssets('ca:ton:'+ton,{fetchImpl:unavailable}),/BRAIN_ASSET_SEARCH_UNAVAILABLE/);
  assert.deepEqual(await searchBrainAssets('nosuch-token',{fetchImpl:async url=>{
    if(url.includes('coingecko'))throw new Error('offline');
    return response({pairs:[]});
  }}),[]);
  const known=await searchBrainAssets('USDC',{fetchImpl:unavailable});
  assert(known.some(a=>a.chain==='base')&&known.some(a=>a.chain==='ethereum'));
});

test('catalog refresh batches aggregate IDs and same-chain pools while preserving order and unrelated identities',async()=>{
  const btc=brainCatalog.find(a=>a.id==='bitcoin'),eth=brainCatalog.find(a=>a.id==='ethereum');
  const a=brainCatalog.find(a=>a.symbol==='AERO'),b=brainCatalog.find(a=>a.symbol==='USDC'&&a.chain==='base');
  const other=brainCatalog.find(a=>a.chain==='arbitrum');
  const now=new Date(Date.now()-900).toISOString();
  const calls=[];
  const rows=await refreshBrainCatalog([a,btc,b,other,eth,btc],{fetchImpl:async u=>{
    calls.push(u);
    if(u.includes('coins/markets'))return response([...markets('bitcoin',now),{...markets('ethereum',now)[0],symbol:'eth',name:'Ethereum'}]);
    if(u.includes('/tokens/v1/base/')){
      const side=pair('base',a.address,215,'3.1');
      side.baseToken.symbol='AERO';
      side.quoteToken={symbol:'USDC',name:'USD Coin',address:b.address};
      return response([side,pair('arbitrum',b.address)]);
    }
    return response([]);
  }});
  assert.equal(calls.length,3);
  assert.equal(calls.filter(u=>u.includes('coins/markets')).length,1);
  assert(calls.some(u=>decodeURIComponent(u).includes('ids=bitcoin,ethereum')));
  assert(calls.some(u=>u.includes('/tokens/v1/base/'+a.address+','+b.address)));
  assert.deepEqual(rows.map(brainAssetKey),[a,btc,b,other,eth].map(brainAssetKey));
  assert.equal(rows[0].price,3.1);assert.equal(rows[1].asOf,now);assert.equal(rows[2],b);assert.equal(rows[3],other);
});

test('catalog refresh keeps unchanged receipts, partial outages, and fully offline data intact',async()=>{
  const btc=brainCatalog.find(a=>a.id==='bitcoin'),a=brainCatalog.find(a=>a.chain==='base');
  const fresh=new Date(Date.now()-1000).toISOString();
  const priced={...btc,price:123.5,change:-1.5,volume:89,asOf:fresh,receivedAt:'2025-01-01T00:00:00.000Z'};
  const isolated=await refreshBrainCatalog([a,priced],{fetchImpl:async u=>{
    if(u.includes('coingecko'))return response(markets('bitcoin',fresh));
    throw new Error('network failed');
  }});
  assert.equal(isolated[1],priced);assert.equal(isolated[0],a);
  const [first]=await refreshBrainCatalog([a],{fetchImpl:async()=>response([pair('base',a.address)])});
  const [second]=await refreshBrainCatalog([first],{fetchImpl:async()=>response([pair('base',a.address)])});
  assert.equal(second,first);
  const offline=await refreshBrainCatalog(brainCatalog,{fetchImpl:unavailable});
  assert(offline.every((a,i)=>a===brainCatalog[i]));
  assert.deepEqual(await refreshBrainCatalog([],{fetchImpl:async()=>assert.fail('no requests expected')}),[]);
});

test('catalog refresh observes in-flight cancellation without partial results and caps DEX concurrency',async()=>{
  const controller=new AbortController();
  let pending=0,max=0,started=0;
  const rows=Array.from({length:9},(_,i)=>({...brainCatalog.find(a=>a.address),chain:'chain'+i}));
  const run=refreshBrainCatalog(rows,{signal:controller.signal,fetchImpl:async (_url,options)=>{
    pending++;started++;max=Math.max(max,pending);
    if(started===3)setTimeout(()=>controller.abort(),0);
    await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>{pending--;reject(options.signal.reason);},{once:true}));
  }});
  await assert.rejects(run,{name:'AbortError'});
  assert.equal(started,3);assert.equal(max,3);assert.equal(pending,0);
});

test('reopening a saved public quote retains its exact contract, venue and original observation times',()=>{
  const saved=brainCatalog.filter(row=>row.symbol==='USDC' && row.address);
  for(const row of saved){
    const restored=readSavedBrainAsset(JSON.parse(JSON.stringify(row)));
    assert.equal(brainAssetKey(restored),brainAssetKey(row));
    assert.deepEqual(restored,row);
    assert.equal(readSavedBrainAsset({...row,sourceUrl:'https://example.org/source'}),null);
    assert.equal(readSavedBrainAsset({...row,chain:'unrelated'}),null);
  }
  const native=brainCatalog.find(row=>row.kind==='native');
  assert.deepEqual(readSavedBrainAsset({...native,sourceUrl:'https://example.org/source'}),native);
  assert.equal(readSavedBrainAsset(null),null);
  assert.equal(readSavedBrainAsset({...native,provider:'unrecognized'}),null);
});

test('selecting a quote-side token or older cached listing keeps its last verified price and source',()=>{
  const previous=brainCatalog.find(row=>row.address && row.price>0);
  const later=new Date(Date.parse(previous.receivedAt)+60000).toISOString();
  const earlier=new Date(Date.parse(previous.receivedAt)-60000).toISOString();
  assert.equal(preferBrainEvidence(previous,{...previous,receivedAt:later,price:null}),previous);
  assert.equal(preferBrainEvidence(previous,{...previous,receivedAt:earlier,price:previous.price+1}),previous);
  assert.equal(preferBrainEvidence(previous,{...previous,chain:'different',receivedAt:later}),previous);
  const updated={...previous,receivedAt:later,price:previous.price+1};
  assert.equal(preferBrainEvidence(previous,updated),updated);
});

test('the live asset ranking and a recalled asset both identify the provider that answered',async()=>{
 const envelope={schema:'public-market-relay-v1',resource:'assets',source:'coinmarketcap',receivedAt:ranking.receivedAt,body:ranking.body};
 const result=await fetchBrainRanking({fetchImpl:async()=>({ok:true,json:async()=>envelope})});
 const asset=result.rows[0];
 assert.equal(asset.provider,'CoinMarketCap');
 assert.equal(new URL(asset.sourceUrl).hostname,'coinmarketcap.com');
 assert.equal(readSavedBrainAsset(asset).provider,'CoinMarketCap');
});
