import {appendFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {strategyPlan} from '../strategy-execution-data.mjs';
import {STRATEGY_IDS,captureBatch,ensureWebhook,listPages,loadLivingBrainEnv,updateBrainProfile} from '../living-brain.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLivingBrainEnv();

function markets(id){
 if(id==='S09-A')return 'dex-spot';
 if(id==='S09-L')return 'dex-lp';
 if(['RX02-P','RX02-A','RX03-S','RX04','RX05'].includes(id))return 'cex-spot, dex-spot';
 return 'cex-spot';
}
function strategyPage(id){
 const plan=strategyPlan(id);
 const risk=plan?.record?.parameters?.risk_fraction?.value??'';
 const origin=`strategy:${id}`;
 return {kind:'note',bucket:'projects',label:id,originRef:origin,content:[
  `策略编号: ${id}`,
  `适用市场: ${markets(id)}`,
  `入场: ${plan?.entry?.[0]||''}`,
  `退出: ${plan?.exit?.[0]||''}`,
  `风险上限: ${risk}`,
  '现在能不能下单: 不能',
  `originRef: ${origin}`
 ].join('\n')};
}
const siteOrigin='strategy:site-rules';
const site={kind:'note',bucket:'projects',label:'site-rules',originRef:siteOrigin,content:[
 '策略编号: site-rules',
 '适用市场: cex-spot, cex-perp, dex-spot, dex-perp, dex-lp, tradfi',
 '入场: 网页保存方案不下单。',
 '退出: 币安现货网格要操作员名单，并且不超过 25 USDT。',
 '风险上限: 模拟盘能启动的只有 S01-SIM 和 S02-SIM。',
 '现在能不能下单: 不能。S09-A 和 S09-L 走链上，不走币安现货。本 brain 记录 18 条策略在各投资入口上的方案。',
 `originRef: ${siteOrigin}`
].join('\n')};

await updateBrainProfile();
const captured=await captureBatch([site,...STRATEGY_IDS.map(strategyPage)]);
console.log(`captured ${captured?.ingested??captured?.sources?.length??0}`);
try{
 const webhook=await ensureWebhook();
 if(webhook.created){
  appendFileSync(path.join(root,'.env.living-brain'),`LIVING_BRAIN_WEBHOOK_SECRET=${webhook.secret}\n`);
  console.log('webhook registered');
 }else console.log('webhook already present');
}catch(error){console.log(`webhook skipped ${error.status||'failed'}`);}
if(process.argv.includes('--verify')){
 const pages=await listPages('limit=100');
 const rules=pages.filter(page=>String(page.body||'').includes('originRef: strategy:'));
 console.log(`strategy pages ${rules.length}`);
}
