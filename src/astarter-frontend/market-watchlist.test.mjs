import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWatchQuery,normalizeDexAssets,watchAssetKey,isWatchAsset,searchWatchAssets,fetchWatchAssets,loadWatchAssets,WATCH_ASSETS_KEY,sameWatchAssetKey} from './market-watchlist.mjs';
import {approvedTokenImageURL,tokenLogo} from './brand-icons.mjs';
const CA='0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const pair=(patch={})=>({chainId:'ethereum',dexId:'uniswap',baseToken:{address:CA,name:'Pepe',symbol:'PEPE'},priceUsd:'0.00001',priceChange:{h24:-4},liquidity:{usd:100000},volume:{h24:1000},marketCap:4200000000,...patch});
const response=body=>({ok:true,text:async()=>JSON.stringify(body)});
test('watch identities accept exact keys and registered aliases without merging names or contracts',()=>{
 assert.equal(sameWatchAssetKey('BTC','coin:bitcoin'),true);
 assert.equal(sameWatchAssetKey('coin:ethereum','ETH'),true);
 assert.equal(sameWatchAssetKey('coin:other-btc','BTC'),false);
 assert.equal(sameWatchAssetKey('coin:other-btc','coin:other-btc'),true);
 assert.equal(sameWatchAssetKey('SPX','SPX'),true);
 const base='ca:base:'+CA.toLowerCase(),eth='ca:ethereum:'+CA.toLowerCase();
 assert.equal(sameWatchAssetKey(base,base),true);assert.equal(sameWatchAssetKey(base,eth),false);assert.equal(sameWatchAssetKey(base,'PEPE'),false);
 for(const key of ['',null,undefined,23,'coin:','ca:base:0x123','BTC ETH'])assert.equal(sameWatchAssetKey(key,key),false);
});
test('names and CA remain distinct; malformed EVM addresses cannot become name searches',()=>{
 assert.deepEqual(parseWatchQuery(' BTC '),{query:'BTC',isAddress:false});assert.equal(parseWatchQuery(CA).isAddress,true);
 assert.equal(parseWatchQuery('So11111111111111111111111111111111111111112').isAddress,true);
 for(const query of ['','0x1234','0x'+'z'.repeat(40),'a'.repeat(101),'BTC\nETH'])assert.throws(()=>parseWatchQuery(query));
});
test('CA results require the exact token address, dedupe pools by chain, and retain the most liquid quote',()=>{
 const rows=normalizeDexAssets({pairs:[pair(),pair({priceUsd:'0.00002',liquidity:{usd:200000}}),pair({chainId:'base'}),pair({baseToken:{address:'0x'+'1'.repeat(40),name:'Imposter',symbol:'PEPE'}})]},CA,1234);
 assert.equal(rows.length,2);assert.equal(rows[0].price,.00002);assert.equal(rows[0].asOf,null);assert.equal(rows[0].receivedAt,1234);assert.notEqual(watchAssetKey(rows[0]),watchAssetKey(rows[1]));
 assert.equal(isWatchAsset(rows[0],['PEPE']),false);assert.equal(isWatchAsset(rows[0],[watchAssetKey(rows[0])]),true);
 assert.deepEqual(normalizeDexAssets([pair({priceUsd:null}),pair({baseToken:{address:'0xBAD',name:'x',symbol:'x'}})]),[]);
});
test('name lookup merges loaded assets by ID; outages retain useful local search results without claiming full coverage',async()=>{
 const local=[{id:'bitcoin',symbol:'BTC',name:'Bitcoin',price:10}];
 const result=await searchWatchAssets('btc',{local,fetchImpl:async()=>response({coins:[{id:'bitcoin',symbol:'btc',name:'Bitcoin'},{id:'other-btc',symbol:'btc',name:'Other BTC'}]})});
 assert.equal(result.rows.length,2);assert.equal(result.rows[0].price,10);assert.notEqual(watchAssetKey(result.rows[0]),watchAssetKey(result.rows[1]));
 const fallback=await searchWatchAssets('btc',{local,fetchImpl:async()=>{throw Error('offline');}});assert.equal(fallback.partial,true);assert.equal(fallback.rows[0].id,'bitcoin');
 await assert.rejects(searchWatchAssets('not-found',{local,fetchImpl:async()=>{throw Error('offline');}}));
});
test('refresh keeps unavailable quotes and their old time instead of stamping them fresh',async()=>{
 const [row]=normalizeDexAssets([pair()],CA,1234);const result=await fetchWatchAssets([row],{fetchImpl:async()=>{throw Error('offline');}});
 assert.equal(result.failed,1);assert.equal(result.rows[0].receivedAt,1234);
 const controller=new AbortController();controller.abort();await assert.rejects(fetchWatchAssets([row],{signal:controller.signal,fetchImpl:async()=>response([pair()])}),{name:'AbortError'});
});
test('stored CA identities are checked and executable or unrelated image URLs never render',()=>{
 const [row]=normalizeDexAssets([pair()],CA,1234);const storage={getItem:key=>key===WATCH_ASSETS_KEY?JSON.stringify([row,{...row,id:'ca:ethereum:0xBAD'},{...row,id:'bad/id'}]):null};
 assert.equal(loadWatchAssets(storage).length,1);
 const image='https://cdn.dexscreener.com/cms/images/'+'a'.repeat(64)+'?width=800&height=800&quality=95&format=auto';assert.equal(approvedTokenImageURL(image),image);
 for(const url of [image.replace('cdn.dexscreener.com','cdn.dexscreener.com.evil.test'),image+'&redirect=https://evil.test',image.replace('/cms/images/','/private/'),'javascript:alert(1)'])assert.equal(approvedTokenImageURL(url),null);
 assert.equal(tokenLogo({symbol:'BTC',chain_id:'ethereum',address:CA}),null);
});


test('legacy symbol favorites never select a different same-name CoinGecko asset',()=>{
 assert.equal(isWatchAsset({id:'bitcoin',symbol:'BTC'},['BTC']),true);
 assert.equal(isWatchAsset({id:'other-btc',symbol:'BTC'},['BTC']),false);
 assert.equal(isWatchAsset({id:'other-btc',symbol:'BTC'},['coin:other-btc']),true);
});

// U3 mapping pin: a contract row never mixes the price of one pool with the venue of another.
test('U3: a contract row takes its price, liquidity and venue from one pool, the most liquid, in either order, and keeps an unnamed DEX unknown',()=>{
 const small=pair({dexId:'uniswap',priceUsd:'0.00001',liquidity:{usd:100000}}),large=pair({dexId:'sushiswap',priceUsd:'0.00002',liquidity:{usd:200000}});
 for(const pairs of [[small,large],[large,small]]){
  const rows=normalizeDexAssets({pairs},CA,1234);
  assert.equal(rows.length,1);assert.deepEqual([rows[0].venue,rows[0].price,rows[0].liquidity],['sushiswap',.00002,200000]);
 }
 for(const dexId of [undefined,null,42,{name:'uniswap'}])assert.equal(normalizeDexAssets([pair({dexId})],CA,1234)[0].venue,'',JSON.stringify(dexId));
});
