import assert from 'node:assert/strict';
import test from 'node:test';
import {validateResearchArchive} from './brain-research-archives.mjs';

const words={zh:'计数单位',en:'Counted unit'};
const basic={count:1,asOf:'2026-11-27T02:02:01Z',startDate:'2026-11-01',endDate:'2026-11-27',
 sourceName:'Source',sourceUrl:'https://example.org/source',unit:words,methodology:words,analysis:words,
 attribution:{name:'Publisher',url:'https://example.org/',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/'},
 stats:[{label:words,value:0}],samples:[{id:'trade-1',date:'2026-11-27T02:01:00.000Z',label:words,value:'123.5 USDC',url:'https://example.org/trades/1'}]};

test('research archive retains measured counts, bilingual facts, source links and legitimate zero',()=>{
 assert.deepEqual(validateResearchArchive(basic),basic);
 for(const breakdown of [{topMarkets:[{coin:'BTC',matches:1,notionalUSDC:'123.456'}]},
  {assetContracts:[{symbol:'PAXG',count:0,chainId:1,issuerUrl:'https://example.org/asset'}]}]){
   assert.equal(validateResearchArchive({...basic,...breakdown}).count,1);
 }
 const empty={...basic,count:0,samples:[],sources:[{name:words,url:'https://example.org/records'}]};
 assert.deepEqual(validateResearchArchive(empty),empty);
});
test('a missing or invalid research record never yields an invented zero or unsafe source link',()=>{
 for(const change of [{count:null},{count:'1'},{count:0},{count:-1},{count:1.5},{endDate:'2026-02-30'},{asOf:'yesterday'},
  {startDate:'2026-12-12'},{unit:{}},{sourceUrl:'https://x@example.org'},{samples:[{...basic.samples[0],url:'javascript:alert(1)'}]},
  {assetContracts:[{symbol:'PAXG',chainId:1,count:1,issuerUrl:'javascript:void(0)'}]},
  {topMarkets:[{coin:'BTC',matches:0,notionalUSDC:'not available'}]},
  {attribution:{...basic.attribution,licenseUrl:'//unverified.invalid'}},{sources:[{name:'Source',url:'data:text/plain,foo'}]},{stats:[{label:words,value:null}]}])
  assert.throws(()=>validateResearchArchive({...basic,...change}),/INVALID_RESEARCH_ARCHIVE/);
});

test('published research archives have traceable samples and comparable breakdown totals',async()=>{
 const {readFile}=await import('node:fs/promises');
 for(const key of ['whale','rwa']){
  const json=await readFile(new URL('./data/research-archives/'+key+'.json',import.meta.url),'utf8');
  const archive=validateResearchArchive(JSON.parse(json));
  assert.ok(archive.count>0&&archive.samples.length>0);
  assert.equal(new Set(archive.samples.map(sample=>sample.id)).size,archive.samples.length);
  for(const sample of archive.samples){
   assert.ok(sample.date.slice(0,10)>=archive.startDate.slice(0,10)&&sample.date.slice(0,10)<=archive.endDate.slice(0,10));
  }
  if(key==='whale'){
   assert.ok(archive.topMarkets.length>0&&archive.topMarkets.reduce((n,row)=>n+row.matches,0)<=archive.count);
   assert.ok(archive.topMarkets.every((row,i)=>!i||row.matches<=archive.topMarkets[i-1].matches));
   assert.equal(archive.attribution.license,'CC BY 4.0');
  }else{
   assert.equal(archive.assetContracts.reduce((n,row)=>n+row.count,0),archive.count);
   assert.equal(new Set(archive.assetContracts.map(row=>row.chainId+':'+row.address.toLowerCase())).size,archive.assetContracts.length);
  }
 }
});
