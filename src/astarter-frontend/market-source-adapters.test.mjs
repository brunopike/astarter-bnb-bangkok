import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeHubResource} from './market-hub-data.mjs';
import {coinMarketCapAssetsBody,coinMarketCapCategoriesBody,coinMarketCapGlobalBody,coinMarketCapRequest,coinMarketCapSentimentBody,pullAtlasPrices} from './market-source-adapters.mjs';
import {createMarketHubRelay} from './market-hub-relay.mjs';

const NOW=Date.parse('2026-11-25T17:21:48.032Z');

test('CoinMarketCap payloads fit the existing market snapshot',()=>{
 const global=coinMarketCapGlobalBody({data:{active_cryptocurrencies:10,active_exchanges:4,btc_dominance:58.5,eth_dominance:10,last_updated:'2026-11-25T17:20:59.999Z',quote:{USD:{total_market_cap:100,total_volume_24h:20,total_market_cap_yesterday_percentage_change:-0.4,total_volume_24h_yesterday_percentage_change:-1}}}});
 assert.equal(normalizeHubResource('global',global,NOW).data.cap,100);
 const assets=coinMarketCapAssetsBody({data:[{id:1,slug:'bitcoin',symbol:'BTC',name:'Bitcoin',cmc_rank:1,last_updated:'2026-11-25T17:21:48.032Z',quote:{USD:{price:59000,market_cap:1e12,volume_24h:2e10,percent_change_24h:1.2,percent_change_7d:-3,last_updated:'2026-11-25T17:21:48.032Z'}}}]});
 const asset=normalizeHubResource('assets',assets,NOW).data[0];
 assert.equal(asset.id,'bitcoin');assert.equal(asset.symbol,'BTC');assert.deepEqual(asset.series,[]);assert.equal(asset.high,undefined);
 const categories=coinMarketCapCategoriesBody({status:{timestamp:'2026-11-25T17:21:48.032Z'},data:[{id:'6433de7df79a2653906cd680',market_cap:1000,market_cap_change:-0.4,volume:50}]});
 assert.equal(normalizeHubResource('categories',categories,NOW).data[0].id,'layer-1');
 const sentiment=coinMarketCapSentimentBody({data:[{timestamp:'1795478400',value:9,value_classification:'Extreme fear'}]});
 assert.equal(normalizeHubResource('sentiment',sentiment,NOW).data[0].value,9);
});

test('the market relay reads CoinMarketCap and falls back to the previous source',async()=>{
 const previous=process.env.COINMARKETCAP_API_KEY;
 process.env.COINMARKETCAP_API_KEY='test-key';
 try{
  const urls=[];
  const handle=createMarketHubRelay({now:()=>NOW,fetchImpl:async url=>{urls.push(String(url));return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({data:{active_cryptocurrencies:10,active_exchanges:4,btc_dominance:58.5,eth_dominance:10,last_updated:'2026-11-25T17:20:59.999Z',quote:{USD:{total_market_cap:100,total_volume_24h:20,total_market_cap_yesterday_percentage_change:-0.4,total_volume_24h_yesterday_percentage_change:-1}}}})};}});
  const seen=[];
  await handle({url:'/api/market-hub?resource=global',method:'GET'},{writeHead(status){seen.push(status);},end(body){seen.push(JSON.parse(body));}});
  assert.equal(seen[0],200);
  assert.equal(seen[1].source,'coinmarketcap');
  assert.equal(seen[1].body.data.total_market_cap.usd,100);
  assert.match(urls[0],/pro-api\.coinmarketcap\.com/);
  assert.equal(coinMarketCapRequest('exchanges'),null);
 }finally{if(previous===undefined)delete process.env.COINMARKETCAP_API_KEY;else process.env.COINMARKETCAP_API_KEY=previous;}
});

test('Atlas signed prices keep the feed id and omit the signing key',async()=>{
 const previous=process.env.ATLAS_API_KEY;
 process.env.ATLAS_API_KEY='test-key';
 try{
  let header;
  const body=await pullAtlasPrices({symbol:'BTC',fetchImpl:async(_url,options)=>{header=options.headers;return {ok:true,json:async()=>({status:{error_code:'0'},data:{priceDetails:[{feedId:'626',price:59000.5,timestampSeconds:'1795627328'}]}})};}});
  assert.equal(header['X-API-KEY'],'test-key');
  assert.deepEqual(body.prices.BTC,{feedId:626,price:59000.5,timestamp:1795627328});
  assert.equal(JSON.stringify(body).includes('test-key'),false);
 }finally{if(previous===undefined)delete process.env.ATLAS_API_KEY;else process.env.ATLAS_API_KEY=previous;}
});
