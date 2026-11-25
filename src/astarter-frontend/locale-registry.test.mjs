import test from 'node:test';
import assert from 'node:assert/strict';
import {LOCALES,normalizeLocale,createMessageCatalog} from './locale-registry.mjs';
test('all eight product languages have stable IDs and native labels',()=>{
 assert.deepEqual(LOCALES.map(x=>x.id),['zh','en','ja','ko','vi','es','fr','ru']);
 assert.equal(normalizeLocale('ko-KR'),'ko');assert.equal(normalizeLocale('EN-us'),'en');assert.equal(normalizeLocale('invalid'),'zh');
});
test('whole messages preserve amounts and IDs while slots follow native sentence order',()=>{
 const c=createMessageCatalog([['使用 {p0} 积分；释放 {p1}。','Used {p0} credits; released {p1}.'],['等待','Waiting']]);
 c.register('fr',{'Used {p0} credits; released {p1}.':'Crédits libérés : {p1} ; utilisés : {p0}.','Waiting':'En attente'});
 assert.equal(c.resolve('使用 16 积分；释放 4。','fr'),'Crédits libérés : 4 ; utilisés : 16.');
 assert.equal(c.resolve('使用 SIM-ORD-112 积分；释放 0.000001。','fr'),'Crédits libérés : 0.000001 ; utilisés : SIM-ORD-112.');
 assert.equal(c.resolve('使用 等待 积分；释放 4。','fr'),'Crédits libérés : 4 ; utilisés : En attente.');
});
test('changing language also handles strings rendered by the previous locale',()=>{
 const c=createMessageCatalog([['等待','Waiting'],['预留 ','Held '],['完成 {p0} 项','Completed {p0} tasks']]);
 c.register('fr',{'Waiting':'En attente','Held ':'Réservé ','Completed {p0} tasks':'Tâches terminées : {p0}'});
 c.register('ja',{'Waiting':'待機中','Held ':'予約済み ','Completed {p0} tasks':'完了タスク数：{p0}'});
 assert.equal(c.resolve('En attente','ja'),'待機中');
 assert.equal(c.resolve('Tâches terminées : 12','ja'),'完了タスク数：12');
 assert.equal(c.resolve(' Held ','fr'),' Réservé ');
 assert.equal(c.resolve('Waiting for custom user content','fr'),null);
});

test('punctuation cannot hide a history suffix, and count suffixes only match numeric values',()=>{
 const c=createMessageCatalog([['{p0} · {p1}历史','{p0} · {p1} history'],['{p0} 个','Count: {p0}']]);
 assert.equal(c.resolve('BTC · Funding rate历史','en'),'BTC · Funding rate history');
 assert.equal(c.resolve('11 个','en'),'Count: 11');assert.equal(c.resolve('custom text 个','en'),null);
});

test('metadata templates localize nested team names and shared versions without changing reference IDs',()=>{
 const c=createMessageCatalog([['生态研究组','On-chain team'],['共享','Shared'],['{p0} / SIM','{p0} / SIM']]);
 c.register('ru',{'On-chain team':'Ончейн-группа','Shared':'Общие','{p0} / SIM':'{p0} / SIM'});
 assert.equal(c.resolve('Crypto / 生态研究组 / v447 / SIM','ru'),'Crypto / Ончейн-группа / v447 / SIM');
 assert.equal(c.resolve('Shared source / 共享 v1 / fixture-ETH-macro','ru'),'Shared source / Общие v1 / fixture-ETH-macro');
});
