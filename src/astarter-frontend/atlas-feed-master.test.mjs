import test from 'node:test';
import assert from 'node:assert/strict';
import {ATLAS_FEEDS,atlasFeedById,atlasFeedFor,atlasMarketFeed,currentAtlasPrice,handleAtlasFeeds} from './atlas-feed-master.mjs';
import {pullAtlasPrices} from './market-source-adapters.mjs';

test('the public Atlas catalog is the feed master list',()=>{
 assert.equal(ATLAS_FEEDS.length,186);
 assert.equal(new Set(ATLAS_FEEDS.map(feed=>feed.id)).size,186);
 assert.equal(atlasFeedFor('BTC').id,626);
 assert.equal(atlasFeedFor('eth').id,632);
 assert.equal(atlasFeedFor('XRP').id,634);
 assert.equal(atlasFeedFor('XRP').name,'XRP/USD');
 assert.equal(atlasFeedFor('APT'),null);
 assert.equal(atlasFeedById(626).symbol,'BTC');
 assert.equal(ATLAS_FEEDS.some(feed=>Object.hasOwn(feed,'price')),false);
});

test('the feed master route returns the catalog and one symbol',async()=>{
 const seen=[];
 const res={writeHead(status,headers){seen.push({status,headers});},end(body){seen.push(body);}};
 assert.equal(await handleAtlasFeeds({url:'/api/markets',method:'GET'},res),false);
 assert.equal(await handleAtlasFeeds({url:'/api/atlas/feeds?symbol=SOL',method:'GET'},res),true);
 assert.equal(seen[0].status,200);
 assert.deepEqual(JSON.parse(seen[1]),{feed:{id:635,symbol:'SOL',name:'SOL/USD',quote:'USD',pull:true,platformIds:[14]}});
});

const SECOND=1_800_000_000;
test('Atlas references bind an exact market asset and expire against the feed clock',()=>{
 const asset={symbol:'BTC',id:'bitcoin'};
 const btc=atlasMarketFeed(asset),price={feedId:626,price:49000,timestamp:SECOND,quote:'USD'};
 assert.equal(btc.id,626);
 assert.equal(atlasMarketFeed({...asset,id:'another-btc'}),null);
 assert.equal(atlasMarketFeed({...asset,address:'0xabc'}),null);
 assert.equal(atlasMarketFeed({symbol:'USDC',id:'usd-coin'}).id,650);
 assert.equal(atlasMarketFeed({symbol:'NVDA',id:'nvidia'}),null);
 assert.equal(currentAtlasPrice(price,btc,SECOND*1000+120000),price);
 assert.equal(currentAtlasPrice(price,btc,SECOND*1000+120001),null);
 assert.equal(currentAtlasPrice(price,btc,SECOND*1000-5001),null);
 assert.equal(currentAtlasPrice({...price,quote:'USDT'},btc,SECOND*1000),null);
 assert.equal(currentAtlasPrice({...price,feedId:632},btc,SECOND*1000),null);
});
test('overview batches keep the right feeds, coalesce fetches and recover from partial service',async t=>{
 const original=process.env.ATLAS_API_KEY;process.env.ATLAS_API_KEY='local-test-only';
 t.after(()=>{if(original===undefined)delete process.env.ATLAS_API_KEY;else process.env.ATLAS_API_KEY=original;});
 let now=SECOND*1000,requests=0,failFirst=true,failAll=false;
 const fetchImpl=async(url,options)=>{
  assert.equal(new URL(url).hostname,'api.atlasoracle.io');
  assert.equal(options.redirect,'error');
  const ids=JSON.parse(options.body).feedIds;assert.ok(ids.length<=18);
  requests++;
  if(failAll||failFirst&&ids.includes('626'))return Response.json({},{status:503});
  const priceDetails=ids.map(id=>({feedId:id,price:'100.5',timestampSeconds:String(Math.floor(now/1000)-1)}));
  priceDetails.push({feedId:'999999',price:'12',timestampSeconds:String(now/1000)});
  if(ids.includes('626')){
   priceDetails.push({feedId:'626',price:0,timestampSeconds:String(now/1000)});
   priceDetails.push({feedId:'632',price:999,timestampSeconds:String(now/1000-1000)});
  }
  return Response.json({status:{error_code:'0'},data:{priceDetails}});
 };
 const load=(symbol)=>pullAtlasPrices({fetchImpl,now:()=>now,symbol});
 const [first,twin]=await Promise.all([load(),load()]);
 assert.equal(requests,2);assert.deepEqual(first,twin);
 assert.ok(first.missing.includes('BTC'));assert.equal(first.prices.USDC.quote,'USD');
 failFirst=false;now+=12000;
 const all=await load();assert.equal(requests,4);assert.equal(Object.keys(all.prices).length,32);
 assert.equal(all.prices.BTC.price,100.5);assert.equal(all.prices.ETH.price,100.5);
 failAll=true;now+=35000;await assert.rejects(load(),/atlas-price-unavailable/);
 const count=requests;await assert.rejects(load(),/atlas-price-unavailable/);assert.equal(requests,count);
 failAll=false;now+=11000;
 const recovered=await load();assert.equal(recovered.prices.BTC.feedId,atlasFeedFor('BTC').id);
 const only=await load('BTC');assert.deepEqual(Object.keys(only.prices),['BTC']);
});
