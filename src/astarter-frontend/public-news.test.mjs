import test from 'node:test';
import assert from 'node:assert/strict';
import {PUBLIC_NEWS_SOURCE,parsePublicNews,projectPublicNews} from './public-news.mjs';
import {validatePublicEnvelope,currentPublicEnvelope} from './public-data-client.mjs';

const now=Date.UTC(2026,10,17,14),published=now-3600000;
const article=(title='Bitcoin and Ethereum updates',link='https://www.coindesk.com/markets/2026/11/17/update',at=published)=>`<item><title><![CDATA[${title}]]></title><link>${link}</link><guid>article-1</guid><pubDate>${new Date(at).toUTCString()}</pubDate><description>Publisher body must not be republished or passed to a model.</description></item>`;
const rss=(items=article())=>`<?xml version="1.0"?><rss version="2.0"><channel><title>CoinDesk</title>${items}</channel></rss>`;
test('official headline projection keeps publication time, multiple assets and a safe source link without publisher body',()=>{
 assert.equal(PUBLIC_NEWS_SOURCE.url,'https://www.coindesk.com/arc/outboundfeeds/rss');
 const raw=rss(),snapshot=parsePublicNews(raw,now),body=projectPublicNews(snapshot,{selection_version:7,limit:20},now+1000);
 assert.equal(validatePublicEnvelope(body,'news',{selection_version:7,limit:20}),body);
 assert.deepEqual(body.items[0].data.symbols,['BTC','ETH']);assert.deepEqual(body.items[0].data.asset_ids,['bitcoin','ethereum']);
 assert.equal(body.items[0].data.summary,'');assert.equal(body.items[0].data.published_at_ms,published);assert.equal(body.items[0].event_time_ms,published);
 assert.equal(body.items[0].valid_until_ms,published+PUBLIC_NEWS_SOURCE.stale);assert.equal(body.as_of_ms,published);assert.equal(body.requested_at_ms,now+1000);
 assert.equal(body.sources[0].provider_id,'coindesk-rss-v1');assert.equal(JSON.stringify(body).includes('Publisher body'),false);assert.equal(snapshot.receivedAt,now);assert.equal(raw,rss());
 const again=projectPublicNews(parsePublicNews(raw,now+60000),{selection_version:8,limit:50},now+60000);
 assert.equal(again.items[0].record_id,body.items[0].record_id);assert.equal(again.items[0].valid_until_ms,body.items[0].valid_until_ms);
 assert.equal(currentPublicEnvelope(again,published+PUBLIC_NEWS_SOURCE.stale+1).items[0].quality,'stale');
});
test('unclassified headlines remain market-wide, symbols use exact words, canonical links deduplicate and order by source publication',()=>{
 const first=article('A Goldman Sachs report','https://www.coindesk.com/policy/report?utm_source=rss',published-1000),newer=article('Solana and gold','https://www.coindesk.com/markets/second',published);
 const result=parsePublicNews(rss(first+newer+first.replace('?utm_source=rss','?utm_source=other')),now);
 assert.equal(result.items.length,2);assert.deepEqual(result.items[0].symbols,['SOL','XAU']);assert.deepEqual(result.items[1].symbols,[]);
 assert.equal(result.items[1].url,'https://www.coindesk.com/policy/report');assert.equal(result.asOf,published);
 const encoded=parsePublicNews(rss(article('Bitcoin &amp; Ethereum &quot;update&quot;')),now);assert.equal(encoded.items[0].title,'Bitcoin & Ethereum "update"');
});
test('malformed XML, foreign links, future publication, invalid dates and unbounded responses fail closed',()=>{
 for(const raw of ['<html>blocked</html>',rss().replace('<rss','<!DOCTYPE rss><rss'),rss().replace('<rss','<!ENTITY x SYSTEM "file:///private"><rss'),rss(article('Title','https://evil.test/news')),rss(article('Title','javascript:alert(1)')),rss(article('Title','https://user:pass@www.coindesk.com/news')),rss(article('Title',undefined,now+61000)),rss().replace(new Date(published).toUTCString(),'not a date'),rss(article().repeat(101)),rss('x'.repeat(PUBLIC_NEWS_SOURCE.maxBytes))])assert.throws(()=>parsePublicNews(raw,now),/INVALID_NEWS/);
});
test('an empty successful feed stays distinct from an invalid response and limits are applied after shared source caching',()=>{
 const empty=projectPublicNews(parsePublicNews(rss(''),now),{selection_version:2,limit:20},now);
 assert.equal(empty.quality,'fresh');assert.equal(empty.coverage.scope,'NEWS_FEED');assert.deepEqual(empty.items,[]);assert.equal(empty.sources[0].status,'OK');
 const snapshot=parsePublicNews(rss(article('Bitcoin','https://www.coindesk.com/one')+article('Ethereum','https://www.coindesk.com/two')),now);
 assert.equal(projectPublicNews(snapshot,{selection_version:3,limit:1},now).items.length,1);assert.equal(snapshot.items.length,2);
});
test('XML comments and CDATA cannot introduce articles, and truncated, nested or duplicate structures are rejected',()=>{
 assert.equal(parsePublicNews(rss(`<!-- ${article()} -->`),now).items.length,0);
 assert.equal(parsePublicNews(rss('<![CDATA[<item><title>Only text</title></item>]]>'),now).items.length,0);
 for(const raw of ['<html><!-- <rss --><channel><title>CoinDesk</title></channel></html>',rss().replace('</rss>',''),'<rss><channel><title>CoinDesk</title></channel></rss><rss/>',rss(article().replace('</title>','</title><title>Second title</title>')),rss().replace('</channel>','</channel><channel><title>CoinDesk</title></channel>')])assert.throws(()=>parsePublicNews(raw,now),/INVALID_NEWS/);
});
