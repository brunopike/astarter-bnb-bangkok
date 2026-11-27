import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {getTradfiAsset,readTradfiObservation,searchTradfiAssets,tradfiGroups} from './brain-tradfi-assets.mjs';
import {createResearchScope} from './brain-research-scope.mjs';
import {brainAssetKey,preferBrainEvidence,readSavedBrainAsset,refreshBrainAsset,refreshBrainCatalog,searchBrainAssets} from './brain-asset-data.mjs';
import {cortexaView} from './brain-cortexa.mjs';

const archiveFile=path=>readFile(new URL('.'+path,import.meta.url),'utf8').then(JSON.parse);
const ids=query=>searchTradfiAssets(query).map(asset=>asset.id);
const getFile=async path=>({ok:true,json:()=>archiveFile(path)});

test('all twenty instruments resolve a real series with the published unit, source and observation day',async()=>{
  const catalog=await archiveFile('/brain-evidence/tradfi/catalog.json');
  const options=searchTradfiAssets();
  assert.equal(new Set(options.map(a=>a.id)).size,20);
  assert.equal(new Set(options.map(a=>a.group)).size,tradfiGroups.length);
  for(const asset of options){
    const actual=catalog.series.find(row=>row.id===asset.id);
    assert.equal(asset.unit,actual.unit);assert.equal(asset.provider,actual.source);assert.equal(asset.sourceUrl,actual.sourceUrl);
    assert.equal(brainAssetKey(asset),'tradfi:'+asset.id);
    const observation=await refreshBrainAsset(asset,{fetchImpl:getFile});
    assert.equal(observation.archiveStart,actual.start);assert.equal(observation.archiveEnd,actual.end);
    assert.equal(observation.archiveCount,actual.count);
    assert.equal(observation.archiveStatus,'ready');
    const scope=createResearchScope(observation,[]);
    assert.equal(scope.asOf,actual.end);assert.equal(scope.tape.asOf,scope.asOf);
    assert(scope.tradfiMetrics.some(row=>row.value.includes(actual.source)));
    assert(scope.quote.every(text=>text.includes(actual.unit)));
    assert.equal(scope.notes.length,14);
    assert(scope.notes.every(note=>note.sourceUrl===asset.sourceUrl));
    assert.doesNotMatch(JSON.stringify([scope.notes,scope.tape,scope.memory]),/CoinGecko|BTC\/|ETH.USDT|24h volume|On-chain identity|Ethereum Merge/);
  }
});

test('symbol, names and category aliases resolve in both languages, within the selected asset type',()=>{
  assert.deepEqual(ids('黄金 gold'),['oracle-gold']);
  assert.deepEqual(ids('布伦特'),['brent']);
  for(const query of ['股票','美国股票','stock','stocks','equities','U.S. equities']){
    assert.deepEqual(ids(query),searchTradfiAssets('','stock').map(a=>a.id));
  }
  for(const [query,group] of [['贵金属','metals'],['原油','energy'],['forex','fx'],['FX','fx'],['funds','etf'],['指数','index']]){
    assert.deepEqual(ids(query),searchTradfiAssets('',group).map(a=>a.id));
  }
  assert.deepEqual(ids('S&P 500'),['taifex-spf','oracle-spy-arbitrum']);
  assert.deepEqual(ids('Nasdaq 100'),['taifex-unf','oracle-qqq']);
  assert.deepEqual(searchTradfiAssets('W T I','energy').map(a=>a.id),['wti']);
  assert.deepEqual(ids('苹果'),['oracle-aapl']);
  assert.deepEqual(searchTradfiAssets('布伦特','fx'),[]);
  assert.deepEqual(ids('BTC'),[]);
});

test('fresh entries ignore individual research assets and retain deliberate archive replay',()=>{
  const before=Object.getOwnPropertyDescriptor(globalThis,'location');
  try{
    for(const key of ['','coin:bitcoin','tradfi:eurjpy','ca:ethereum:0x0000000000000000000000000000000000000001','coin:unknown','eth-merge']){
      const url=new URL('https://example.test/?lang=zh');
      if(key)url.searchParams.set('scope',key);
      Object.defineProperty(globalThis,'location',{configurable:true,value:url});
      const initial=cortexaView.initialSelection();
      assert.equal(initial.key,key==='eth-merge'?'eth-merge':'all');
      assert.equal(initial.asset,null);
      if(key!=='eth-merge')assert(initial.research.cryptoCount>0 && initial.research.tradfiCount>0);
    }
  }finally{
    if(before)Object.defineProperty(globalThis,'location',before);else delete globalThis.location;
  }
});

test('TradFi asset lookups use their own archive and sanitize saved observations',async()=>{
  const requests=[];
  const fetchImpl=async url=>{requests.push(url);return getFile(url);};
  assert.deepEqual(await searchBrainAssets('tradfi:unknown',{fetchImpl}),[]);
  const [asset]=await searchBrainAssets('tradfi:wti',{fetchImpl});
  const saved=readSavedBrainAsset({...asset,price:20000,sourceUrl:'https://example.test/forged-price'});
  assert.equal(saved.price,null);assert.equal(saved.sourceUrl,asset.sourceUrl);
  assert.equal(brainAssetKey({...asset,id:'unknown'}),'');
  assert.deepEqual(await refreshBrainCatalog([asset],{fetchImpl}),[asset]);
  const selected=await refreshBrainAsset(saved,{fetchImpl});
  assert.equal(requests.length,1);assert.equal(requests[0],asset.archiveUrl);
  assert.equal(preferBrainEvidence(selected,asset),selected);
});

test('missing observations and crossed series always withhold the quote; invalid dates and expiry are rejected',async()=>{
  const wti=getTradfiAsset('wti');
  const unavailable=await refreshBrainAsset(wti,{fetchImpl:async()=>({ok:true,json:async()=>({id:'brent',rows:[['2024-06-04',75]]})})});
  const scope=createResearchScope(unavailable,[]);
  assert.equal(scope.asOf,null);assert.equal(scope.quote[1],'Archive unavailable');assert.equal(scope.marketRows.length,0);
  assert.equal(readTradfiObservation(wti,{id:'wti',rows:[['2024-02-30',10]]}),null);
  const negative=readTradfiObservation(wti,{id:'wti',rows:[['2020-04-20',-36.98]]});
  assert.equal(createResearchScope(negative,[]).quote[1],'-36.98 USD/bbl');
  const future=getTradfiAsset('taifex-spf');
  assert.equal(readTradfiObservation(future,{id:future.id,rows:[['2026-11-25',100]]}),null);
  const contract=readTradfiObservation(future,{id:future.id,rows:[['2026-11-25',100,null,null,null,30,'202612']]});
  assert(createResearchScope(contract,[]).tradfiMetrics.some(row=>row.value[1]==='2026-12'));
});

test('the default research scope includes all twenty TradFi instruments and keeps price metrics scoped to crypto',async()=>{
  const before=Object.getOwnPropertyDescriptor(globalThis,'location');
  try{
    Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://example.test/'}});
    const initial=cortexaView.initialSelection(),scope=initial.research;
    assert.equal(initial.key,'all');assert.deepEqual(scope.label,['All','All']);
    assert.equal(scope.asset,null);assert.equal(scope.quote,null);assert.equal(scope.asOf,null);
    assert.equal(scope.tradfiCount,20);assert(scope.cryptoCount>0);
    assert.equal(scope.rows.length,scope.cryptoCount+scope.tradfiCount);
    assert(scope.marketRows.every(row=>row.kind!=='tradfi'));
    const selected=await refreshBrainAsset(getTradfiAsset('eurjpy'),{fetchImpl:getFile});
    const mixed=createResearchScope(null,scope.rows.map(row=>row.id===selected.id?selected:row));
    assert(mixed.tradfiGroups.find(row=>row.id==='fx').assets.some(row=>row.archiveEnd===selected.archiveEnd));
    assert.equal(mixed.cryptoAsOf,scope.cryptoAsOf);assert.equal(mixed.volume,null);assert.equal(mixed.liquidity,null);
    assert.equal(mixed.asOf,null);assert.equal(mixed.quote,null);
    assert(mixed.tape.phases.find(phase=>phase.title[1]==='TradFi instruments').rows.some(row=>row[2].includes('EUR/JPY')));
    assert(mixed.notes.some(note=>note.body[1].includes('USD/troy oz') && note.body[1].includes('JPY/EUR')));
    assert(!mixed.marketRows.some(row=>row.id===selected.id));
  }finally{
    if(before)Object.defineProperty(globalThis,'location',before);else delete globalThis.location;
  }
});
