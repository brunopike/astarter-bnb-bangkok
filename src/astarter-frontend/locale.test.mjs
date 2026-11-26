import test from 'node:test';import assert from 'node:assert/strict';import {translate,pair,loadLocale} from './locale.mjs';
test('a fresh production locale defaults to English without persistent storage',async()=>{
 const fresh=await import('./locale.mjs?verify-production-default');await fresh.localeReady;
 assert.equal(fresh.pair('中文','English'),'English');
});
test('shared snapshot refresh messages have complete translations in every supported locale',async()=>{
 const entries=[['固定快照','Fixed snapshot'],['刷新仅核对当前快照；自动刷新间隔与行情共用。','Refresh checks this snapshot only; the auto-refresh interval is shared with markets.'],['当前快照未变化','The current snapshot is unchanged']];
 for(const lang of ['ja','ko','vi','es','fr','ru']){
  await loadLocale(lang);
  for(const [zh,en]of entries){const text=pair(zh,en,lang);assert.notEqual(text,zh,lang);assert.notEqual(text,en,lang);}
 }
});
test('data-center source names are translated inside an agent report',async()=>{
 const source='A01 · BTC · 数据中心线索：BTC 行情观察';
 assert.equal(translate(source),'A01 · BTC · Data Center leads: BTC Market review');
 assert.equal(translate(source,'zh'),source);
 for(const locale of ['ko','vi','es','fr','ru']){await loadLocale(locale);const result=translate(source,locale);assert.ok(!/[\u3400-\u9fff]/u.test(result),locale+': '+result);assert.ok(result.startsWith('A01 · BTC · '));assert.ok(result.includes('BTC '));}
 await loadLocale('ja');assert.notEqual(translate(source,'ja'),source);assert.ok(!translate(source,'ja').includes('行情观察'));
});
test('English preserves trade identity, amounts and simulation qualifier',()=>{assert.equal(translate('AI 协作台'),'AI Workspace');assert.equal(translate('SIM-ORD-112 · 回执未知 · 100 USDT'),'SIM-ORD-112 · Unknown receipt · 100 USDT');assert.equal(translate('◎ −16 / 退 4'),'◎ −16 / Release 4');});
test('product copy preserves ordinary Chinese and rewrites authoring qualifiers',()=>{assert.equal(translate('已成交','zh'),'已成交');assert.equal(translate('账户私有复核'),'Private account check');assert.equal(translate('模拟交互 · 非策略性能验证'),'UI flow · Not a strategy performance test');assert.equal(translate('保留 3 · 旁证 4'),'Retained 3 · Context 4');});
test('setup and assistant copy translate as complete phrases',()=>{assert.equal(translate('选择观察范围'),'Choose the research scope');assert.equal(translate('信号处理方式'),'Signal handling');assert.equal(translate('打开协作工作台'),'Open AI workspace');assert.equal(translate('协作'),'Workspace');assert.equal(translate('开始使用'),'Get started');assert.equal(translate('策略合同正文保留中文原文，避免替换改变参数含义。'),'Strategy contract text stays in the original Chinese so wording changes do not alter parameters.');assert.equal(translate('核心尚未汇总，不能交给策略执行。'),'The core has not finished this review, so it cannot go to strategy execution.');});
test('tracking labels unify actions and accessible asset names without rewriting research prose',()=>{
 for(const old of ['关注','收藏','追踪'])assert.equal(translate(old,'zh'),'追踪');
 for(const old of ['已关注','已收藏','已加入自选','已追踪'])assert.equal(translate(old,'zh'),'已追踪');
 for(const old of ['自选','我的关注','我的自选','我的追踪'])assert.equal(translate(old,'zh'),'我的追踪');
 assert.equal(translate('取消收藏 BTC','zh'),'取消追踪 BTC');
 assert.equal(translate('+ 关注','zh'),'+ 追踪');
 assert.equal(translate('收藏 accumulation','en'),'Track accumulation');
 const source='关注度上升，收藏量增加；关注下一次回到观察区间的表现。';
 assert.equal(translate(source,'zh'),source);
 assert.equal(translate('现货 BTC/USDT · 81,230','zh'),'现货 BTC/USDT · 81,230');
});
test('tracking vocabulary is localized consistently in all eight languages',async()=>{
 for(const [lang,action,state,stop]of [
  ['zh','追踪','已追踪','取消追踪'],['en','Track','Tracking','Stop tracking'],
  ['ja','追跡','追跡中','追跡を解除'],['ko','추적','추적 중','추적 해제'],
  ['vi','Theo dõi','Đang theo dõi','Ngừng theo dõi'],['es','Seguir','En seguimiento','Dejar de seguir'],
  ['fr','Suivre','Suivi actif','Arrêter le suivi'],['ru','Отслеживать','Отслеживается','Прекратить отслеживание']
 ]){
  await loadLocale(lang);assert.equal(pair('关注','Follow',lang),action);
  assert.equal(pair('已收藏','Saved',lang),state);assert.equal(translate('取消收藏 ETH',lang),stop+' ETH');
  assert.notEqual(translate('追踪账户',lang),translate('追踪动态',lang));
 }
});

test('legacy product names resolve to the current trading and signals labels in all eight languages',async()=>{
 const {pair,translate,loadLocale}=await import('./locale.mjs');
 const names={zh:['AI 交易','智选信号'],en:['LensWave','Smart Signals'],ja:['AI スペクトラム','スマートシグナル'],ko:['AI 스펙트럼','스마트 시그널'],vi:['Phổ AI','Tín hiệu thông minh'],es:['Espectro IA','Señales inteligentes'],fr:['Spectre IA','Signaux intelligents'],ru:['Спектр ИИ','Умные сигналы']};
 for(const [locale,expected] of Object.entries(names)){
  await loadLocale(locale);
  assert.equal(pair('AI 战队','AI team',locale),expected[0]);
  assert.equal(pair('AI 信号','AI signals',locale),expected[1]);
  assert.equal(translate('AI Spectrum',locale),expected[0]);
  assert.equal(translate('Smart Signals',locale),expected[1]);
 }
});


test('six-stage titles and live meter labels translate without a research update',async()=>{
 const {photonicRuntime,photonicStageMeter}=await import('./photonic-workbench.mjs');
 const tasks=[{symbol:'BTC',phase:'complete',outcome:'candidate',evidence:[{key:'trend',status:'retain'}]},{symbol:'ETH',phase:'core',progress:37,evidence:[{key:'depth',status:'pending'}]}];
 const before=structuredClone(tasks),phases=photonicRuntime({},tasks);
 for(const [index,phase]of phases.entries()){
  assert.equal(translate(phase.zh,'en'),phase.en);
  assert.equal(translate(`0${index+1} ${phase.zh}`,'en'),`0${index+1} ${phase.en}`);
  const label=photonicStageMeter(phase,tasks).match(/aria-label="([^"]+)"/)[1],english=translate(label,'en');
  assert.doesNotMatch(english,/[\u3400-\u9fff]/u,english);
  assert.deepEqual(english.match(/\d+(?:\.\d+)?/g),label.match(/\d+(?:\.\d+)?/g));
  assert.equal(translate(label,'zh'),label);
 }
 assert.equal(translate('已分流 8 · 候选 2 · 观察 4 · 复核 2','en'),'Routed 8 · Candidates 2 · Watching 4 · Review 2');
 assert.equal(translate('判断已完成 —','en'),'Reviewed —');
 assert.deepEqual(tasks,before);
});

test('LensWave and AI 交易 localize product labels while physical spectrum keeps its meaning',async()=>{
 const {pair,translate}=await import('./locale.mjs');
 assert.equal(translate('AI 星谱','en'),'LensWave');assert.equal(pair('AI 星谱','AI Spectrum','en'),'LensWave');
 assert.equal(pair('星谱盈亏','Spectrum P&L','en'),'LensWave P&L');assert.equal(translate('星谱交易记录','en'),'LensWave trade history');assert.equal(pair('运行光谱','Runtime spectrum','en'),'LensWave runtime');
 assert.equal(pair('AI 星谱','LensWave','zh'),'AI 交易');assert.equal(pair('星谱盈亏','LensWave P&L','zh'),'AI 交易盈亏');assert.equal(translate('星谱交易记录','zh'),'AI 交易记录');assert.equal(pair('运行光谱','LensWave runtime','zh'),'运行光谱');
 assert.equal(translate('seven spectrum beams','en'),'seven spectrum beams');assert.equal(translate('七束光谱','zh'),'七束光谱');assert.equal(translate('LENSWAVE','zh'),'LENSWAVE');
});

test('data center menu and page headings use the same category names',async()=>{
 const categories=[['社媒动态','Social activity'],['新闻舆情','News & sentiment']];
 for(const locale of ['zh','en','ja','ko','vi','es','fr','ru']){
  await loadLocale(locale);
  for(const [name,en] of categories){
   assert.equal(translate(name,locale),pair(name,en,locale));
   if(locale==='en')assert.equal(translate(name,locale),en);
  }
 }
});
