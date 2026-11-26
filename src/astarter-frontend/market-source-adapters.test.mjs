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

test('the market relay sends the CMC key only to CoinMarketCap and reports the provider of the returned snapshot',async t=>{
 const previous=process.env.COINMARKETCAP_API_KEY;
 process.env.COINMARKETCAP_API_KEY='test-key';
 t.after(()=>{if(previous===undefined)delete process.env.COINMARKETCAP_API_KEY;else process.env.COINMARKETCAP_API_KEY=previous;});
 const global={btc_dominance:58.5,eth_dominance:10,last_updated:new Date(NOW).toISOString(),quote:{USD:{total_market_cap:100,total_volume_24h:20,total_market_cap_yesterday_percentage_change:-0.4}}};
 const alternative={data:{total_market_cap:{usd:120},total_volume:{usd:20},market_cap_percentage:{btc:58.5},market_cap_change_percentage_24h_usd:-0.4,updated_at:NOW/1000}};
 for(const cmcAvailable of [true,false]){
  const hosts=[];
  const handle=createMarketHubRelay({now:()=>NOW,fetchImpl:async(url,{headers})=>{
   const {hostname,pathname}=new URL(url);hosts.push(hostname);
   if(hostname==='pro-api.coinmarketcap.com'){
    assert.equal(pathname,'/v1/global-metrics/quotes/latest');
    assert.equal(headers['X-CMC_PRO_API_KEY'],'test-key');
    return Response.json({status:{error_code:cmcAvailable?0:1001},data:global});
   }
   assert.equal(hostname,'api.coingecko.com');
   assert.equal(pathname,'/api/v3/global');
   assert.equal(headers['X-CMC_PRO_API_KEY'],undefined);
   return Response.json(alternative);
  }});
  let status,record;
  await handle({url:'/api/market-hub?resource=global',method:'GET'},{writeHead(code){status=code;},end(body){record=JSON.parse(body);}});
  assert.equal(status,200);
  assert.equal(record.source,cmcAvailable?'coinmarketcap':'coingecko');
  assert.equal(record.body.data.total_market_cap.usd,cmcAvailable?100:120);
  assert.deepEqual(hosts,cmcAvailable?['pro-api.coinmarketcap.com']:['pro-api.coinmarketcap.com','api.coingecko.com']);
 }
 assert.equal(coinMarketCapRequest('exchanges'),null);
});

test('Atlas requests a signed report and returns only the fresh requested USD feed without its API key',async t=>{
 const previous=process.env.ATLAS_API_KEY;
 process.env.ATLAS_API_KEY='test-key';
 t.after(()=>{if(previous===undefined)delete process.env.ATLAS_API_KEY;else process.env.ATLAS_API_KEY=previous;});
 const timestamp=Math.floor(NOW/1000);
 const rows=[
  {feedId:'626',price:59000.5,timestampSeconds:String(timestamp)},
  {feedId:'632',price:2200,timestampSeconds:String(timestamp)},
  {feedId:'626',price:59100,timestampSeconds:String(timestamp+60)}
 ];
 const body=await pullAtlasPrices({symbol:'BTC',now:()=>NOW,fetchImpl:async(url,options)=>{
  assert.equal(url,'https://api.atlasoracle.io/report/v1/price/latest');
  assert.equal(options.method,'POST');
  assert.equal(options.headers['X-API-KEY'],'test-key');
  assert.deepEqual(JSON.parse(options.body),{signed:true,feedIds:['626']});
  return Response.json({status:{error_code:'0'},data:{priceDetails:rows}});
 }});
 assert.deepEqual(body,{configured:true,source:'Atlas Oracle',prices:{BTC:{feedId:626,price:59000.5,timestamp,quote:'USD'}},missing:[]});
 assert.equal(JSON.stringify(body).includes('test-key'),false);
});

test('a stale CMC observation yields only to a newer valid fallback, with the original provider and clock',async t=>{
 const previous=process.env.COINMARKETCAP_API_KEY;
 process.env.COINMARKETCAP_API_KEY='test-key';
 t.after(()=>{if(previous===undefined)delete process.env.COINMARKETCAP_API_KEY;else process.env.COINMARKETCAP_API_KEY=previous;});
 const now=Math.floor(NOW/1000)*1000,observed=now-600_000;
 const cmc={status:{error_code:0},data:{btc_dominance:55,last_updated:new Date(observed).toISOString(),quote:{USD:{total_market_cap:100,total_volume_24h:2,total_market_cap_yesterday_percentage_change:1}}}};
 const gecko=at=>({data:{total_market_cap:{usd:200},total_volume:{usd:4},market_cap_percentage:{btc:55},market_cap_change_percentage_24h_usd:2,updated_at:at/1000}});
 const route=coinMarketCapRequest('global');
 for(const [fallback,source,at] of [[gecko(now),'coingecko',now],[gecko(observed-1000),'coinmarketcap',observed],[{},'coinmarketcap',observed],[null,'coinmarketcap',observed]]){
  const result=await route.collectSnapshot(async request=>{
   if(typeof request==='object')return cmc;
   assert.equal(request,'https://api.coingecko.com/api/v3/global');
   if(!fallback)throw Error('offline');
   return fallback;
  },()=>now);
  assert.equal(result.source,source);
  assert.equal(result.body.data.updated_at,at/1000);
  assert.equal(result.body.data.total_market_cap.usd,source==='coinmarketcap'?100:200);
 }
});
