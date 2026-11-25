import test from 'node:test';
import assert from 'node:assert/strict';
import {presentationCopy} from './product-presentation.mjs';

test('presentation removes authoring badges and keeps operational labels concise in Chinese and English',()=>{
 for(const label of ['演示数据','模拟数据','Demo data'])assert.equal(presentationCopy(label),'');
 assert.equal(presentationCopy('历史示例价'),'记录价格');
 assert.equal(presentationCopy('Example portfolio'),'Portfolio');
 assert.equal(presentationCopy('开启模拟交易权限'),'开启交易权限');
 assert.equal(presentationCopy('2 example plans'),'2 plans');
 assert.equal(presentationCopy('模拟资产'),'账户资产');
 assert.equal(presentationCopy('Spot · 5m · Rehearsal example'),'Spot · 5m');
 assert.equal(presentationCopy('假设数据演示策略规则，条件尚未核实，不是实时交易信号。'),'假设参数，条件尚未核实；不构成实时交易信号。');
});
test('presentation never changes amounts, source dates, identifiers, rejection states or payment confirmations',()=>{
 for(const text of ['SIM-01','DEMO','PAPER','LIVE','BTC/USDT','12,241 Credit','2026-10-24 14:00 UTC+8','CoinGecko','权限不足','订单结果待确认','0x1234567890abcdef'])assert.equal(presentationCopy(text),text);
 assert.equal(presentationCopy(false),false);assert.equal(presentationCopy(0),0);
});

test('presentation keeps standalone separators between adjacent elements',()=>{
 assert.equal(presentationCopy(' · '),' · ');
 assert.equal(presentationCopy('·'),'·');
 assert.equal(presentationCopy('Binance Spot / USDT · '),'Binance Spot / USDT · ');
});

 test('product actions lose authoring jargon without claiming an exchange connection or a payment',()=>{
 assert.equal(presentationCopy('启动模拟'),'开始运行');
 assert.equal(presentationCopy('Start simulation'),'Start run');
 assert.equal(presentationCopy('模拟支付 · 真实收费关闭'),'真实扣款未启用');
 assert.equal(presentationCopy('当前为模拟退款，不发生真实资金转移。'),'不会转移资金。');
 assert.equal(presentationCopy('Credit 不足，请先充值模拟余额。'),'Credit 不足，请先补充余额。');
 assert.match(presentationCopy('模拟账户；持仓按当前模拟口径计价。'),/未提交至交易所/);
 assert.equal(presentationCopy('这里只接受演示值，请勿粘贴真实密钥。'),'连接尚未开放，请勿粘贴真实密钥。');
});

test('preset records, hypothetical inputs and service boundaries remain explicit',()=>{
 assert.equal(presentationCopy('固定样本'),'预设数据');
 assert.equal(presentationCopy('Fixed sample'),'Preset data');
 assert.equal(presentationCopy('Fixed historical examples'),'Preset data');
 assert.equal(presentationCopy('Hypothetical inputs illustrate the strategy; conditions are unverified and are not a live trading signal.'),'Hypothetical inputs; conditions remain unverified. This is not a live trading signal.');
 assert.match(presentationCopy('这里生成可恢复的模拟结果；不会调用真实模型。已知条件检查保持免费。'),/未调用模型/);
 assert.match(presentationCopy('当前使用固定信号和模拟成交。检查的是设置与操作流程，尚无真实回测收益。'),/尚未进行历史回测/);
 assert.match(presentationCopy('This creates a recoverable fixture result without calling a real model. Deterministic checks remain free.'),/no model call/);
 assert.match(presentationCopy('Uses scripted signals and simulated fills. Checks cover setup and workflow, not historical strategy returns.'),/No historical backtest/);
});
test('presentation is stable across repeated DOM localization and preserves adjacent fragments',()=>{
 for(const source of ['内置交互演练样例','Demo data · Simulation only','共享可用模拟余额不足，未创建 BOT。','The local demo uses a fixed stop-distance fixture.','固定样本','A01 · BTC · ']){
  const once=presentationCopy(source);assert.equal(presentationCopy(once),once,source);
 }
 assert.equal(presentationCopy('A01 · BTC · '),'A01 · BTC · ');
});
test('translation callers include option labels and retain scoped identifiers in all eight locales',async()=>{
 const {pair,translate,loadLocale}=await import('./locale.mjs');
 for(const [id,expected]of [['zh','参考数据 · 只读'],['en','Reference data · Read only'],['ja','参考データ · 読み取り専用'],['ko','참고 데이터 · 읽기 전용'],['vi','Dữ liệu tham khảo · Chỉ đọc'],['es','Datos de referencia · Solo lectura'],['fr','Données de référence · Lecture seule'],['ru','Справочные данные · Только чтение']]){
  await loadLocale(id);assert.equal(pair('参考数据 · 只读','Reference data · Read only',id),expected);
  assert.equal(translate('SIM-01',id),'SIM-01');assert.equal(presentationCopy('DEMO'),'DEMO');
 }
 assert.equal(pair('模拟账户','Demo account','zh'),'本机账户');
 assert.equal(translate('模拟付款','en'),'Payment flow');
});

test('dynamic elapsed labels retain durations without authoring terminology',()=>{
 for(const [before,after]of [['模拟 3时27分','运行 3时27分'],['信号记录价格 · 模拟 0秒','信号记录价格 · 运行 0秒'],['Sim 0s','Run 0s'],['Sim 3h 27m','Run 3h 27m'],['Record price · Sim 1d 2h','Record price · Run 1d 2h']])assert.equal(presentationCopy(before),after);
 for(const id of ['SIM-01','SIM-22','Sim Archive','SimulationClock'])assert.equal(presentationCopy(id),id);
});
