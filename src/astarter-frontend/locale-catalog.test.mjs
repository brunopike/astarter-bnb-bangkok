import test from 'node:test';
import assert from 'node:assert/strict';
import {messages} from './locale-messages.mjs';
import {translate,loadLocale,pair,LOCALES} from './locale.mjs';
import {receiptSummary} from './core-reports.mjs';
const slots=s=>[...s.matchAll(/\{p\d+\}/g)].map(x=>x[0]).sort();
const numbers=s=>[...s.replace(/\{p\d+\}/g,'').matchAll(/\d+(?:[.,]\d+)*/g)].map(x=>x[0]).sort();
const english=[...new Set(messages.map(([,en])=>en))];
test('Agent save and launch actions do not reuse bookmark or chart-origin translations',async()=>{
 for(const [id,save,start]of [['ja','設定を保存','開始'],['ko','설정 저장','시작'],['vi','Lưu cài đặt','Khởi chạy'],['es','Guardar','Iniciar'],['fr','Enregistrer','Démarrer'],['ru','Сохранить','Запустить']]){
  await loadLocale(id);assert.equal(pair('保存','Save setup',id),save);assert.equal(pair('启动','Launch',id),start);
  assert.notEqual(pair('保存','Save setup',id),pair('收藏','Save',id));assert.notEqual(pair('启动','Launch',id),pair('起点','Start',id));
  assert.notEqual(pair('交易平台','Trading venue',id),'Trading venue');
 }
});
for(const locale of LOCALES.filter(x=>!['zh','en'].includes(x.id))){
 test(`${locale.name}: complete catalog with unchanged parameters`,async()=>{
  const pack=(await import(`./locales/${locale.id}.mjs`)).default;
  await loadLocale(locale.id);
  for(const key of english){
   assert.equal(typeof pack[key],'string',`${locale.id}: missing ${key}`);
   assert.deepEqual(slots(pack[key]),slots(key),`${locale.id}: placeholders ${key}`);
   assert.deepEqual(numbers(pack[key]),numbers(key),`${locale.id}: parameters ${key}`);
   if(locale.id!=='ja')assert.doesNotMatch(pack[key],/[\u3400-\u9fff]/,`${locale.id}: Chinese residue ${key}`);
  }
  assert.notEqual(pair('暂停买入','Pause buys',locale.id),'Pause buys');
  assert.notEqual(pair('AI 现场','Live',locale.id),'Live');
  assert.notEqual(pair('采集','Collecting',locale.id),'Collecting');
  assert.notEqual(pair('操作台','Controls',locale.id),'Controls');
  for(const badge of ['✓ 核验','◎ 积分','↗ 复盘','BTC 资金费率']){const localized=translate(badge,locale.id);assert.notEqual(localized,badge);if(locale.id!=='ja')assert.doesNotMatch(localized,/[\u3400-\u9fff]/);}
  const report=receiptSummary({stage:'confirm',key:'credits:112',context:{job:{business:true,taskType:'credits',settled:16,released:4}}},null,locale.tag);
  assert.match(report.text,/16/);assert.match(report.text,/4/);
  assert.equal(report.key,'credits:112');assert.equal(report.kind,'credits');
  assert.notEqual(report.text,'16 credits used; 4 released.');
 });
}
test('all extracted Chinese interface messages have complete English text',()=>{
 for(const [source]of messages.filter(([source])=>/[\u3400-\u9fff]/.test(source)))assert.doesNotMatch(translate(source,'en'),/[\u3400-\u9fff]/,source);
});

test('sorting decorations do not turn an exact metric name into a template parameter',async()=>{
 for(const locale of LOCALES.filter(x=>x.id!=='zh')){
  await loadLocale(locale.id);
  const label=translate('持仓量',locale.id);
  for(const arrow of ['↕','↑','↓'])assert.equal(translate(`持仓量 ${arrow}`,locale.id),`${label} ${arrow}`);
 }
 assert.equal(translate('0.0081% ↑','en'),'0.0081% ↑');
});

test('connection access choices translate as complete phrases instead of mixed-language fragments',async()=>{
 for(const id of ['ja','ko','vi','es','fr','ru']){
  await loadLocale(id);
  for(const [zh,en]of [['先看数据，不下单','View data without trading'],['查看账户，不授权转账或交易','View the account; no transfers or trades']]){
   const rendered=pair(zh,en,id);assert.notEqual(rendered,en);assert.doesNotMatch(rendered,/without trading|no transfers or trades/);
  }
 }
});

test('subscription states and review actions use the selected language',async()=>{
 for(const id of ['ja','ko','vi','es','fr','ru']){
  await loadLocale(id);
  for(const [zh,en]of [['免费权益已包含','Free benefits included'],['已有下期订阅','Next period already scheduled'],['查看下期订阅','View scheduled subscription'],['确认订阅','Review subscription'],['确认下期换档','Review next-period change'],['无需续订','No renewal needed']])assert.notEqual(pair(zh,en,id),en,id+': '+en);
 }
});

test('shared trading access states and recovery actions are fully localized',async()=>{
 const {ACCESS_COPY}=await import('./trading-access.mjs?v=20261120c');
 for(const id of ['ja','ko','vi','es','fr','ru']){
  await loadLocale(id);
  for(const entry of Object.values(ACCESS_COPY))for(const [z,en]of [[entry[0],entry[1]],[entry[2],entry[3]],[entry[5],entry[6]]])if(z&&en)assert.notEqual(pair(z,en,id),en,id+': '+en);
 }
});

test('signal ordering, evidence history and current-market actions use each selected language',async()=>{
 for(const id of ['ja','ko','vi','es','fr','ru']){
  await loadLocale(id);
  for(const [zh,en]of [['切换 AI 信号与市场数据','Switch AI signals and market data'],['显示全部','Fit all'],['刷新行情','Refresh market'],['核对当前行情','Check current market'],['观察记录','Observation history'],['方案优先','Plans first'],['最新记录','Latest records'],['信号排序','Signal order'],['线索持续性减弱，重新检查风险','Persistence weakens; reviewing the changed risk']])assert.notEqual(pair(zh,en,id),en,id+': '+en);
 }
});

test('connection setting notes and inbox refresh states use each selected language',async()=>{
 const texts=[['首选接入只用于新建草稿；已有运行继续使用原接入。','Preferred is used for new drafts only. Existing runs keep their original connection.'],['有未保存的更改，保存后才会生效。','Unsaved changes. They apply only after you save.'],['已取消，未保存的更改已放弃；已保存的设置不变。','Cancelled. Unsaved changes were discarded; saved settings are unchanged.'],['暂时无法更新，已保留上次数据','Unable to update; previous data retained'],['自动刷新：','Auto refresh: '],['秒','seconds'],['秒后重试','seconds']];
 for(const id of ['ja','ko','vi','es','fr','ru']){
  await loadLocale(id);
  const pack=(await import(`./locales/${id}.mjs`)).default;
  for(const [zh,en]of texts){
   const rendered=pair(zh,en,id);
   assert.notEqual(rendered.trim(),en.trim(),id+': '+en);
   assert.equal(typeof pack[en],'string',id+': missing '+en);
   assert.equal(rendered,pack[en].trim()+(en.endsWith(' ')?' ':''),id+': '+en);
   if(id!=='ja')assert.doesNotMatch(rendered,/[㐀-鿿]/,id+': '+en);
  }
  assert.doesNotMatch(pair('自动刷新：','Auto refresh: ',id)+'60 '+pair('秒','seconds',id),/Auto refresh|seconds/,id);
  // Keep the short time unit "sec" separate from "seconds".
  assert.equal(translate('秒',id),pack.sec,id+': 秒');
 }
 assert.equal(translate('秒','en'),'sec');
});

test('the market refresh cooldown line and the market source hint names use each selected language, the watch-scope note in the word its scope button shows',async()=>{
 const hints=[['数据来源与时间','Source and time'],['关于我的追踪','About my tracking']];
 // The scope note uses the same localized tracking label as the Watchlist button in market-hub.mjs (see trackingCopy in locale.mjs).
 const sameWord=id=>{
  const button=pair('自选','Watchlist',id).trim(),note=pair('关于我的追踪','About my tracking',id);
  assert.ok(button&&note.toLocaleLowerCase(id).includes(button.toLocaleLowerCase(id)),id+': '+note+' / '+button);
 };
 assert.equal(pair('关于我的追踪','About my tracking','zh'),'关于我的追踪');
 assert.equal(pair('关于我的追踪','About my tracking','en'),'About my tracking');
 for(const id of ['zh','en'])sameWord(id);
 for(const id of ['ja','ko','vi','es','fr','ru']){
  await loadLocale(id);
  const pack=(await import(`./locales/${id}.mjs`)).default;
  // The cooldown notice joins "Try again in", the remaining time, and the localized "seconds" label.
  const line=pair('请在','Try again in',id)+' '+30+' '+pair('秒后重试','seconds',id);
  assert.doesNotMatch(line,/(?<![\p{L}\p{M}])(?:try|again|in|seconds?|sec)(?![\p{L}\p{M}])/iu,id+': '+line);
  if(id!=='ja')assert.doesNotMatch(line,/[㐀-鿿]/,id+': '+line);
  assert.equal(typeof pack['Try again in'],'string',id+': missing Try again in');
  assert.equal(line,pack['Try again in']+' 30 '+pack.seconds,id+': '+line);
  for(const [zh,en]of hints){
   const rendered=pair(zh,en,id);
   assert.notEqual(rendered,en,id+': '+en);
   assert.equal(typeof pack[en],'string',id+': missing '+en);
   assert.equal(rendered,pack[en],id+': '+en);
   if(id!=='ja')assert.doesNotMatch(rendered,/[㐀-鿿]/,id+': '+en);
  }
  sameWord(id);
 }
});

test('account inbox and notification settings texts, the notices tab badge and the market resource names use each selected language',async()=>{
 const texts=[
  // private-ui-controller.mjs: status labels, the signed-out gate, feedback, notification settings and the inbox.
  ['尚未读取云端','Cloud state not loaded'],['已读取账户数据','Account data loaded'],['正在保存','Saving'],['云端已有新版本，请重新读取','Cloud state changed. Load it again.'],['结果待确认，请查询原请求','Unconfirmed. Check the original request.'],['请登录后继续','Sign in to continue'],['当前登录未获账户访问权限','This session cannot access account settings'],['暂时无法连接，请重试读取','Unavailable. Try loading again.'],
  ['当前登录未获账户访问权限。','This session cannot access account settings.'],['更新登录后即可使用账户工作区和站内通知。','Update sign-in to use your account workspace and inbox.'],['登录后读取账户偏好和研究通知。','Sign in to load account preferences and research notices.'],['更新登录','Update sign-in'],['操作未完成，请核对当前设置后重试。','Not completed. Check the current settings and retry.'],
  ['账户通知','Account notifications'],['重新读取','Reload cloud'],['站内通知','In-app notices'],['风险提醒','Risk alerts'],['保存通知偏好','Save notification preferences'],['外部推送','External delivery'],['尚未启用','Not enabled'],
  ['账户通知','Account inbox'],['仅显示当前页','Showing the current page'],['风险提醒','Risk alert'],['研究通知','Research notice'],['已读','Read'],['标为已读','Mark read'],['本页标为已读','Mark this page read'],['暂无账户通知','No account notices yet'],
  // workbench-console.mjs: the notices tab badge.
  ['未读提醒','Unread reminders'],
  // private-ui-controller.mjs: the account workspace view.
  ['账户工作区','Account workspace'],['已保存到当前账户','Saved to this account'],['已应用到本机','Applied on this device'],['读取云端','Load cloud'],['应用偏好','Apply preferences'],['保存当前偏好','Save current preferences'],['云端草稿目录','Cloud draft directory'],['账户偏好已应用；草稿仅同步名称目录。','Account preferences applied; drafts sync as a name directory.'],
  // market-hub.mjs resourceLabel; "DeFi TVL" is a proper name and has no entry.
  ['全市场','Global market'],['资产快照','Asset snapshots'],['现货定时快照','Spot polling snapshot'],['赛道','Sectors'],['交易平台','Trading venues'],['公链 TVL','Chain TVL'],['稳定币','Stablecoins'],['市场情绪','Market sentiment']
 ];
 for(const id of ['ja','ko','vi','es','fr','ru']){
  await loadLocale(id);
  const pack=(await import(`./locales/${id}.mjs`)).default;
  for(const [zh,en]of texts){
   const rendered=pair(zh,en,id);
   assert.equal(typeof pack[en],'string',id+': missing '+en);
   assert.equal(rendered,pack[en],id+': '+en);
   assert.notEqual(rendered,en,id+': '+en);
   if(id!=='ja')assert.doesNotMatch(rendered,/[㐀-鿿]/,id+': '+en);
  }
  assert.match(pair('公链 TVL','Chain TVL',id),/(?<![\p{L}])TVL(?![\p{L}])/u,id);
  // The workbench notices badge joins the tab name, the unread label, and the count.
  const badge=pair('通知','Notices',id)+' · '+pair('未读提醒','Unread reminders',id)+' 2';
  assert.doesNotMatch(badge,/Notices|Unread|reminders/,id+': '+badge);
 }
 // Each Chinese source label keeps its existing lookup when two English variants share it.
 // Key the alternate English variants separately for venue, reload, in-app notices, account notices, and risk alerts.
 const last=zh=>messages.filter(([source])=>source.trim()===zh).at(-1)?.[1];
 assert.deepEqual(['交易平台','重新读取','站内通知','账户通知','风险提醒'].map(last),['Trading venue','Read again','In-app notifications','Account notifications','Risk alert']);
});

test('the remove-button name of a saved source follows each language’s word order and leaves the existing remove texts as they were',async()=>{
 // Translate "Remove {name}" before inserting the escaped provider name so that the name stays intact.
 // {name} is not a catalog slot ({p0}, {p1}, ...), so the entry is never used as a pattern for other texts.
 assert.deepEqual(slots('Remove {name}'),[]);
 assert.equal(pair('移除 {name}','Remove {name}','zh'),'移除 {name}');
 assert.equal(pair('移除 {name}','Remove {name}','en'),'Remove {name}');
 for(const [id,nameFirst]of [['ja',true],['ko',true],['vi',false],['es',false],['fr',false],['ru',false]]){
  await loadLocale(id);
  const pack=(await import(`./locales/${id}.mjs`)).default,template=pair('移除 {name}','Remove {name}',id);
  assert.equal(template,pack['Remove {name}'],id);
  assert.equal(template.split('{name}').length,2,id+': '+template);
  assert.deepEqual(slots(template),[],id+': '+template);
  assert.ok(nameFirst?template.startsWith('{name}'):template.endsWith('{name}'),id+': '+template);
  assert.doesNotMatch(template,/Remove/,id);
  // Other button names that start with "Remove" keep their own whole entries.
  assert.equal(pair('移除所选工具','Remove selected tool',id),pack['Remove selected tool'],id);
  assert.doesNotMatch(pack['Remove selected tool'],/Remove|selected|tool/,id);
  for(const en of ['Remove','Remove Binance tool','Remove duplicate shares','Remove from favorites','Remove from watchlist','Remove trading access'])assert.equal(translate(en,id),pack[en],id+': '+en);
 }
});

test('the remove-button entry changes no other text: every text with Remove, 移除 or 删除 renders the same with and without it',async t=>{
 const six=['ja','ko','vi','es','fr','ru'],all=['zh','en',...six];
 const index=messages.findIndex(([,en])=>/^Remove \{[a-z0-9]+\}$/.test(en)),entry=messages[index],key=entry?.[1];
 assert.ok(index>=0,'the remove-button entry');
 // A second copy of locale.mjs, built while the entry is absent from the catalog and from every pack.
 messages.splice(index,1);
 let without;
 try{without=await import('./locale.mjs?without-remove-button-entry');}finally{messages.splice(index,0,entry);}
 for(const id of six){
  await loadLocale(id);
  const pack=(await import(`./locales/${id}.mjs`)).default,value=pack[key];
  delete pack[key];
  try{await without.loadLocale(id);}finally{pack[key]=value;}
 }
 // translate() is what the page translator (locale.mjs initLocale) applies to text already on the page, in the selected language.
 const changed=[],checked=new Set();
 const same=(text,where)=>{checked.add(text);for(const id of six){const now=translate(text,id),before=without.translate(text,id);if(now!==before)changed.push(`${where} · ${id}: "${text}" was "${before}", now "${now}"`);}};
 const samePair=(zh,en,where)=>{for(const id of all){const now=pair(zh,en,id),before=without.pair(zh,en,id);if(now!==before)changed.push(`${where} · ${id}: ${en} was "${before}", now "${now}"`);same(now,where);}};
 for(const [zh,en,where]of [
  ['移除资料：','Remove source: ','trading-assistant.mjs L74'],['移除','Remove','trading-assistant.mjs L94'],['移除所选工具','Remove selected tool','trading-assistant.mjs L196'],['移除 Binance 工具','Remove Binance tool','trading-assistant.mjs L226'],
  ['模拟权限失效','Remove trading access','execution-views.mjs L102'],['剔除重复传播','Remove duplicate shares','strategy-art.mjs L283'],['移除追踪','Remove from watchlist','market-watchlist.mjs L87'],
  ['自选最多保存 200 个，请先移除一些','Watchlist is full (200). Remove an asset first.','market-watchlist.mjs L75'],['已达保存上限，请移除不用的项目或选择更高容量套餐。','The saved-item limit has been reached. Remove unused items or choose a higher-capacity plan.','membership-account.mjs L5-L6']
 ])samePair(zh,en,where);
 // product-presentation.mjs L254 rewrites into these; locale.mjs L265, L554 and L569 hold these.
 for(const text of ['移除交易权限','Remove trading access','Simulate revoked access','取消关注','最多追踪200个资产，请先移除一些','You can track up to 200 assets. Remove an asset first.'])same(text,'presentation and tracking copy');
 // Labels built from the verb and a value: the research report chips (trading-assistant.mjs L94) and the watchlist button (market-watchlist.mjs L87), as rendered in every language.
 const {RESEARCH_OPTIONS}=await import('./assistant-analysis.mjs');
 for(const id of all){
  for(const value of ['BTC','ETH',...Object.keys(RESEARCH_OPTIONS.sectors)])same(pair('移除','Remove',id)+' '+value,'trading-assistant.mjs L94');
  for(const name of ['BTC',pair('未识别标的','Unidentified asset',id)])same(name+' · '+pair('移除追踪','Remove from watchlist',id),'market-watchlist.mjs L87');
  same(pair('移除资料：','Remove source: ',id)+'BTC 1h','trading-assistant.mjs L74');
 }
 // Strategy copy covers both removal and deletion in strategy-catalog.mjs.
 const {CATALOG}=await import('./strategy-catalog.mjs'),seen=new Set();
 const walk=value=>typeof value==='string'?[value]:value&&typeof value==='object'&&!seen.has(value)?(seen.add(value),Object.values(value).flatMap(walk)):[];
 const strategyTexts=walk(CATALOG).filter(text=>/移除|删除|Remove /.test(text));
 assert.ok(strategyTexts.length>=2,'strategy texts');
 for(const text of strategyTexts)same(text,'strategy-catalog.mjs');
 // Every other catalog text and pack value that starts or ends with a remove verb, in any language.
 const verb=/^(?:Remove |移除|删除|削除|Gỡ |Xóa |Quitar |Eliminar |Retirer |Supprimer |Убрать |Удалить )|(?:削除|제거|삭제)$/u;
 for(const [zh,en]of messages)if(en!==key&&(verb.test(zh)||verb.test(en)))samePair(zh,en,'locale-messages.mjs');
 for(const id of six){const pack=(await import(`./locales/${id}.mjs`)).default;for(const [en,value]of Object.entries(pack))if(en!==key&&verb.test(value))same(value,'locales/'+id+'.mjs');}
 t.diagnostic('texts checked in six languages: '+checked.size);
 assert.ok(checked.size>100,'texts checked: '+checked.size);
 assert.deepEqual(changed,[]);
});
