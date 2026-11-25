import test from 'node:test';
import assert from 'node:assert/strict';
import {ATLAS_FEEDS,atlasFeedById,atlasFeedFor,handleAtlasFeeds} from './atlas-feed-master.mjs';

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
