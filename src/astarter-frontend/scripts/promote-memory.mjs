import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {archivePage,captureBatch,listPages,loadLivingBrainEnv,pageVersions,runBrief} from '../living-brain.mjs';

loadLivingBrainEnv();
const period=process.argv[2]||'day';
const now=Date.now();
const week=7*86400000;

async function pages(){
 const rows=[];
 for(let offset=0;offset<500;offset+=50){
  const batch=await listPages(`limit=50&offset=${offset}&includeArchived=true`);
  rows.push(...batch);
  if(batch.length<50)break;
 }
 return rows;
}
function origin(page){
 const line=String(page.body||'').split('\n').find(row=>row.startsWith('originRef: '));
 return line?line.slice('originRef: '.length).trim():'';
}
function field(page,label){
 return (String(page.body||'').match(new RegExp(`^${label}: (.+)$`,'m'))||[])[1]||'';
}
function recent(page){
 const at=Date.parse(page.updatedAt||page.createdAt||0);
 return Number.isFinite(at)&&now-at<=week;
}

if(period==='day'){
 await runBrief().catch(error=>console.log(`brief ${error.status||'failed'}`));
 console.log('day brief requested');
}
const all=period==='day'?[]:await pages();
if(period==='week'){
 const groups=new Map();
 for(const page of all.filter(recent)){
  const ref=origin(page);
  const match=ref.match(/^user:([0-9a-f]{16}):plan:/);
  if(!match)continue;
  const strategy=field(page,'策略编号'),market=field(page,'市场类型'),choice=`${field(page,'参数名')}|${field(page,'金额')}|${field(page,'上限')}`;
  if(!strategy||!market||!choice.replace(/\|/g,''))continue;
  const key=`${strategy}|${market}|${choice}`;
  const row=groups.get(key)||{strategy,market,choice,users:new Set()};
  row.users.add(match[1]);
  groups.set(key,row);
 }
 const items=[];
 for(const row of groups.values()){
  if(row.users.size<2)continue;
  const summary=row.choice.replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'choice';
  const ref=`lesson:${row.strategy}:${row.market}:${summary}:week`;
  items.push({kind:'note',bucket:'ideas',label:`${row.strategy} ${row.market}`,originRef:ref,content:[
   `策略编号: ${row.strategy}`,
   `市场类型: ${row.market}`,
   `参数名: ${row.choice.split('|')[0]}`,
   `反复出现的选择: ${row.choice}`,
   `originRef: ${ref}`
  ].join('\n')});
 }
 if(items.length)await captureBatch(items);
 await runBrief().catch(error=>console.log(`brief ${error.status||'failed'}`));
 console.log(`week lessons ${items.length}`);
}
if(period==='month'){
 const contested=all.filter(page=>page.status==='contested'&&origin(page).startsWith('strategy:'));
 console.log(contested.map(page=>page.slug||origin(page)).join('\n')||'no contested strategy pages');
}
if(period==='quarter'){
 const changed=[];
 for(const page of all.filter(page=>origin(page).startsWith('strategy:'))){
  const versions=await pageVersions(page.slug).catch(()=>[]);
  const rows=Array.isArray(versions)?versions:versions?.items||[];
  if(rows.length>1)changed.push(origin(page));
 }
 if(changed.length){
  const ref='lesson:site-rules:review:version-review:quarter';
  await captureBatch([{kind:'note',bucket:'ideas',label:'quarterly parameter review',originRef:ref,content:[
   '策略编号: site-rules',
   '市场类型: review',
   `参数名: ${changed.join(', ')}`,
   '反复出现的选择: 这些策略页在本季有新版本，只作为候选，不改策略代码。',
   `originRef: ${ref}`
  ].join('\n')}]);
 }
 console.log(`quarter candidates ${changed.length}`);
}
if(period==='half'){
 let archived=0;
 for(const page of all.filter(page=>page.status==='stale'&&origin(page).startsWith('lesson:'))){
  await archivePage(page.slug).catch(()=>{});
  archived++;
 }
 console.log(`half archived ${archived}`);
}
if(period==='year'){
 const kept=all.filter(page=>/^(strategy:|lesson:)/.test(origin(page))&&page.status!=='archived');
 const file=path.join(homedir(),'.config/astarter/memory-export.md');
 await mkdir(path.dirname(file),{recursive:true});
 await writeFile(file,kept.map(page=>`# ${page.title||origin(page)}\n\n${page.body||''}\n`).join('\n'));
 console.log(`year export ${kept.length}`);
}
