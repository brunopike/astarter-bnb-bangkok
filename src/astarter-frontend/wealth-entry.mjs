import {L} from './execution-views.mjs';
import {captureProductFocus} from './product-composition.mjs';
import {escapeUI as e} from './product-experience.mjs';
import {validateStrategyConfig} from './wealth-strategies.mjs';
import {WEALTH_ENTRY_CATALOG as catalog} from './wealth-entry-catalog.mjs';
import {validateWealthPublicMarket,WEALTH_MARKET_ASSETS} from './wealth-market-data.mjs';

const copy=value=>Array.isArray(value)?L(...value):value;
const profile=id=>catalog.profiles.find(row=>row.id===id)||catalog.profiles.find(row=>row.id===catalog.defaultProfileId);
const risk=value=>({high:L('高风险','High risk'),medium:L('中风险','Medium risk'),low:L('低风险','Low risk'),defensive:L('防守型','Defensive')})[value];

export function wealthEntryCapability(value,href,{assetId=value?.assetId,now=Date.now()}={}){
 try{
  const url=new URL(href);
  if(value?.schema==='wealth-public-market-v1'&&url.protocol==='https:'){
   validateWealthPublicMarket(value,assetId,now);return {state:'cloud-readonly',readOnly:true,realFundingEnabled:false,testFundingEnabled:false,modelEnabled:false,trackingEnabled:false};
  }
  if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname))return {state:'unavailable',realFundingEnabled:false};
  if(value?.chainId!==31337||value.liveEnabled!==false||typeof value.testFundingEnabled!=='boolean'||!/^[a-f0-9]{64}$/.test(value.configHash||''))return {state:'unsupported',realFundingEnabled:false};
  const config=validateStrategyConfig(value.config);
  if(config.liveEnabled!==false)return {state:'unsupported',realFundingEnabled:false};
  return {state:'local-test',realFundingEnabled:false,testFundingEnabled:value.testFundingEnabled,configVersion:config.version};
 }catch{return {state:'unsupported',realFundingEnabled:false};}
}

// This entry never enables real money. The existing child supports only chain 31337.
const walletAccountId=value=>{const id=typeof value==='string'?value.toLowerCase():'';return /^0x[0-9a-f]{40}$/.test(id)?id:'';};
const finiteAmount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e15?value:null;
const walletAmount=value=>finiteAmount(value)==null?'—':new Intl.NumberFormat(L('zh-CN','en-GB'),{maximumFractionDigits:2}).format(value);
export function createWealthEntry({root,dialog,show,notify=()=>{},storage,wallet=()=>null,fetchImpl=globalThis.fetch,loadView=()=>import('./ai-wealth.mjs'),href=()=>globalThis.location?.href||'',onChange=()=>{},now=Date.now,timeoutMs=10000}){
 let selected=catalog.defaultProfileId,assetId=profile(selected).defaultAssetId,lastSearch;
 let active=false,destroyed=false,phase='idle',capability={state:'unavailable',realFundingEnabled:false},controller=null,generation=0,request=null,child=null,childHost=null,mode='preview',observation=null,marketError=null,expiryTimer=null;
 const current=()=>profile(selected);
 const localTest=()=>{try{const url=new URL(href());return url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname);}catch{return false;}};
 const state=()=>({active,phase,mode,selected,assetId,observation:observation?structuredClone(observation):null,capability:{...capability}});
 function readRoute(){
  const url=new URL(href()||'http://localhost'),params=url.searchParams;
  if(url.search===lastSearch)return;
  lastSearch=url.search;
  if(params.get('page')!=='wealth'||!params.has('strategy')&&!params.has('asset'))return;
  const next=profile(params.get('strategy')||selected),asset=params.get('asset');
  const nextAsset=next.assetIds.includes(asset)?asset:next.defaultAssetId;
  if(next.id!==selected||nextAsset!==assetId){
   if(nextAsset!==assetId||mode==='local'||phase==='opening'){
    cancelCheck();stopChild();mode='preview';phase='idle';capability={state:'unavailable',realFundingEnabled:false};
   }
   selected=next.id;assetId=nextAsset;
  }
  if(params.has('strategy')&&params.get('strategy')!==selected||params.has('asset')&&asset!==assetId)syncURL();
 }
 function syncURL(){if(!globalThis.history?.replaceState)return;const url=new URL(href());url.searchParams.set('strategy',selected);url.searchParams.set('asset',assetId);globalThis.history.replaceState(globalThis.history.state,'',url);lastSearch=url.search;}
 function freshObservation(){return observation&&observation.assetId===assetId&&observation.asOf<=now()+30000&&now()-observation.asOf<=180000&&observation.expiresAt>now()?observation:null;}
 function marketContent(){
  const source=freshObservation(),asset=WEALTH_MARKET_ASSETS[assetId],expired=Boolean(observation&&!source),message=phase==='loading'?L('正在更新','Updating'):expired||marketError==='MARKET_STALE'?L('数据已过期','Data expired'):marketError==='MARKET_RATE_LIMITED'?L('来源限流，稍后重试','Source rate limited. Retry shortly.'):marketError==='MARKET_TIMEOUT'?L('读取超时，请重试','Request timed out. Retry.'):source?source.paused||source.frozen||!source.active?L('池供应暂停','Pool supply paused'):L('已更新','Updated'):L('底层数据暂不可用','Underlying data unavailable');
  let liquidity='—';if(source){const amount=BigInt(source.availableLiquidityUnits),scale=10n**BigInt(asset.decimals),fraction=(amount%scale*1000n/scale).toString().padStart(3,'0').replace(/0+$/,'');liquidity=new Intl.NumberFormat(L('zh-CN','en-GB'),{maximumFractionDigits:0}).format(amount/scale)+(fraction?'.'+fraction:'');}
  return `<section class="wealth-entry-market" aria-labelledby="wealth-market-title"><div class="wealth-entry-market-head"><div><span>Aave V3 · Ethereum</span><h3 id="wealth-market-title">${L('底层供给参考','Underlying supply reference')}</h3></div><button id="wealth-reference-refresh" type="button" class="p-button" data-wealth-entry-action="retry"${phase==='loading'?' aria-disabled="true" aria-busy="true"':''}>${L('刷新','Refresh')}</button></div><div class="wealth-entry-assets" role="group" aria-label="${L('参考资产','Reference asset')}">${current().assetIds.map(id=>`<button id="wealth-reference-${id}" type="button" data-wealth-entry-asset="${id}" aria-pressed="${id===assetId}">${WEALTH_MARKET_ASSETS[id].symbol}</button>`).join('')}</div><dl class="wealth-entry-market-values"><div><dt>${L('供给参考 APR','Supply reference APR')}</dt><dd data-wealth-reference-apr>${source?e(source.aprPercent)+'<span>%</span>':'—'}</dd></div><div><dt>${L('池内可用流动性','Available pool liquidity')}</dt><dd class="wealth-entry-liquidity">${e(liquidity)}${source?`<span>${asset.symbol}</span>`:''}</dd></div></dl><footer><span role="status"${expired?' data-stale="true"':''}>${message}${source?` · <time datetime="${new Date(source.asOf).toISOString()}">${new Date(source.asOf).toLocaleTimeString(L('zh-CN','en-GB'),{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>`:''}</span>${source?`<a href="${e(source.url)}" target="_blank" rel="noopener noreferrer">${L('区块','Block')} #${e(source.blockNumber)} ↗</a>`:''}</footer><p>${L('仅此借贷池的参考，不代表本产品收益。','This lending-pool reference is not the product’s return.')}</p></section>`;
 }
 // Each product shows its own terms version: the catalog version plus that product's fee-terms id.
 function facts(p){return [
  [L('条款版本','Terms version'),catalog.sourceVersion+' · '+p.fees.version],
  [L('策略','Strategy'),copy(p.strategy.name)],
  [L('可选资产','Assets'),p.assetIds.map(id=>catalog.assets.find(a=>a.id===id).symbol).join(' / ')],
  [L('封闭期 / 期限','Lock / term'),p.terms.lockDays+' / '+p.terms.maturityDays+' '+L('自然日','calendar days')],
  [L('封闭期规则','Lock rule'),L('自份额确认时起算，封闭期内不可赎回','Starts at share confirmation; no redemption during the lock')],
  [L('赎回付款','Redemption payout'),'T+'+p.terms.settlementDays+' '+L('自然日，自赎回受理时起算','calendar days after redemption acceptance')],
  [L('管理年费','Annual management fee'),(p.fees.managementRate*100)+'%'],
  [L('认购费','Subscription fee'),(p.fees.subscriptionRate*100)+'%'],
  [L('高水位提成','High-water-mark fee'),(p.fees.performanceRate*100)+'%'],
  [L('提前赎回费','Early redemption fee'),(p.terms.earlyRedemptionBps/100)+'% · '+L('到期后0%','0% at maturity')],
  [L('费用顺序','Fee order'),L('每日净值计提管理费 → 新高收益提成 → 提前赎回费','Daily NAV management accrual → new-gain performance fee → early exit fee')],
  [L('到期处理','At maturity'),L('赎回，不自动续期','Redeem; no automatic rollover')]
 ];}
 function content(){
  if(mode==='local')return `<header class="wealth-entry-head"><div><h1>AI ${L('理财','Wealth')}</h1><p>${L('本地测试金库 · 真实资金未开放','Local test vault · Real funding disabled')}</p></div><button type="button" class="p-button" data-wealth-entry-action="back">${L('返回产品','Back to products')}</button></header><div data-wealth-entry-child></div>`;
  const p=current(),available=phase==='ready'&&capability.state==='local-test';
  let connected=null;try{const value=wallet();const accountId=walletAccountId(value?.accountId);if(accountId)connected={accountId,usdt:finiteAmount(value.usdt),btc:finiteAmount(value.btc)};}catch{connected=null;}
  const balances=connected?`<div><dt>${L('钱包','Wallet')}</dt><dd>${e(connected.accountId.slice(0,6)+'…'+connected.accountId.slice(-4))}</dd></div><div><dt>${L('网络','Network')}</dt><dd>BNB Chain</dd></div><div><dt>${L('持有价值','Holding value')}</dt><dd>${connected.usdt==null?'—':e(walletAmount(connected.usdt))+'<span>USDT</span>'}</dd></div>${connected.btc>0?`<div><dt>BTC</dt><dd>${e(walletAmount(connected.btc))}<span>BTC</span></dd></div>`:''}<div><dt>${L('待到账','Pending payout')}</dt><dd>—</dd></div>`:`<div><dt>${L('持有价值','Holding value')}</dt><dd>—</dd></div><div><dt>${L('待到账','Pending payout')}</dt><dd>—</dd></div>`;
  const confirmedEmpty=connected&&connected.usdt===0&&!(connected.btc>0);
  const fundLabel=confirmedEmpty?L('余额不足','No balance'):L('仅支持 BSC','BSC only');
  const fundingNote=connected?L('这是已连接的 BNB Chain 钱包余额。仅支持 BSC。','This is the connected wallet balance on BNB Chain. BSC only.'):L('仅支持 BSC 钱包。','BSC wallets only.');
  const status=localTest()?phase==='loading'?L('正在检查服务','Checking service'):available?L('本地测试服务可用','Local test service available'):L('资金服务暂未开放','Funding service unavailable'):L('链上数据 · 只读','On-chain data · Read only');
  return `<header class="wealth-entry-head"><div><h1>AI ${L('理财','Wealth')}</h1><p>${L('选择策略，查看风险与资金条款','Choose a strategy and review its risks and terms')}</p></div><span class="wealth-entry-status" role="status">${status}</span></header>
  <nav class="wealth-entry-choices" aria-label="${L('理财产品','Wealth products')}">${catalog.profiles.map(row=>`<button id="wealth-product-${row.id}" type="button" data-wealth-entry-profile="${row.id}" aria-pressed="${row.id===selected}"><b>${e(copy(row.name))}</b><span>${e(copy(row.strategy.name))}</span><small>${risk(row.risk)}</small></button>`).join('')}</nav>
  <div class="wealth-entry-layout"><section class="wealth-entry-detail" aria-labelledby="wealth-entry-profile-title"><header><span>${risk(p.risk)}</span><h2 id="wealth-entry-profile-title">${e(copy(p.name))}</h2><p>${e(copy(p.goal))}</p></header><p class="wealth-entry-risk">${e(copy(p.riskNote))}</p>
  ${localTest()?'':marketContent()}<details class="wealth-entry-terms" data-persist-key="wealth-terms"><summary>${L('产品条款 · 候选草案','Product terms · Candidate draft')}</summary><dl>${facts(p).map(([k,v])=>`<div><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join('')}</dl><p>${L('以上为测试候选条款，正式投入前须重新核对生效版本；不提供本金或收益保证。','These are test-candidate terms. Review the effective version before any real funding. Principal and returns are not guaranteed.')}</p></details>
  <details class="wealth-entry-proof" data-persist-key="wealth-proof"><summary>${L('已有验证范围','Verified scope')}</summary><p>${L('已有本地测试链的投入、份额、净值、受限调仓与赎回闭环，以及真实模型提案的验收记录。该验证不涵盖主网协议或真实资金。','Existing acceptance covers local-test-chain funding, shares, NAV, constrained rebalancing and redemption, including real model proposals. It does not cover mainnet protocols or real funds.')}</p><span>${L('条款版本','Terms version')} · ${e(catalog.sourceVersion)}</span></details></section>
  <aside class="wealth-entry-controls" aria-label="${L('理财资金操作','Wealth funding controls')}"><h2>${L('投入与赎回','Fund and redeem')}</h2><dl class="wealth-entry-balances">${balances}</dl><p>${fundingNote}</p><button type="button" class="p-button p-primary wealth-entry-fund is-empty" disabled>${fundLabel}</button>${localTest()?`<button type="button" class="p-button" data-wealth-entry-action="retry"${phase==='loading'?' aria-disabled="true" aria-busy="true"':''}>${L('重新检查连接','Check connection again')}</button>`:''}${available?`<button type="button" class="p-button" data-wealth-entry-action="test">${L('打开本地测试金库','Open local test vault')}</button>`:''}</aside></div>`;
 }
 function render(){readRoute();return `<section class="wealth-entry wealth-root" data-wealth-entry data-no-translate>${content()}</section>`;}
 function mountChild(){const target=root.querySelector('[data-wealth-entry-child]');if(target&&childHost&&childHost.parentNode!==target)target.appendChild(childHost);}
 function paint(){
  if(!active||destroyed)return;
  const host=root.querySelector('[data-wealth-entry]');
  if(host){
   const restore=captureProductFocus(host);
   const expanded=new Set([...(host.querySelectorAll?.('details[open][data-persist-key]')||[])].map(el=>el.dataset.persistKey));
   host.innerHTML=content();mountChild();
   for(const el of host.querySelectorAll?.('details[data-persist-key]')||[])el.open=expanded.has(el.dataset.persistKey);
   restore();
  }
  onChange();
 }
 function stopChild(){child?.destroy();child=null;childHost=null;}
 function cancelCheck(){generation++;controller?.abort();controller=null;request=null;clearTimeout(expiryTimer);expiryTimer=null;observation=null;marketError=null;}
 async function publicJSON(response,bounded){
  const invalid=()=>{try{void response.body?.cancel().catch(()=>{});}catch{}return Error('MARKET_INVALID');};
  if(response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')||'')||!response.body?.getReader)throw invalid();
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>16384))throw invalid();
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),parts=[];let bytes=0;
  try{for(;;){const chunk=await bounded(reader.read());if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>16384)throw Error('MARKET_INVALID');parts.push(decoder.decode(chunk.value,{stream:true}));}parts.push(decoder.decode());return JSON.parse(parts.join(''));}
  finally{try{void reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
 }
 async function check(){
  if(!active||destroyed)return false;if(request)return request;
  const token=++generation,asset=assetId,isLocal=localTest(),aborter=new AbortController();controller=aborter;const signal=aborter.signal;let timedOut=false,rejectStop;
  const stopped=new Promise((_,reject)=>rejectStop=reject);stopped.catch(()=>{});const abort=()=>rejectStop(Error(timedOut?'MARKET_TIMEOUT':'REQUEST_ABORTED'));signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;aborter.abort();},Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=10000?timeoutMs:10000),bounded=promise=>Promise.race([promise,stopped]);
  clearTimeout(expiryTimer);expiryTimer=null;if(!isLocal){observation=null;marketError=null;}phase='loading';paint();
  request=(async()=>{
   try{
    const exchange=Promise.resolve(fetchImpl(isLocal?'/api/wealth/manager/vault/config':'/api/wealth/market?asset='+encodeURIComponent(asset),{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal}));
    void exchange.then(response=>{if(signal.aborted||token!==generation)try{void response.body?.cancel().catch(()=>{});}catch{}},()=>{});
    const response=await bounded(exchange);if(isLocal&&!response.ok){try{void response.body?.cancel().catch(()=>{});}catch{}throw Error('SERVICE_UNAVAILABLE');}
    const value=await bounded(isLocal?response.json():publicJSON(response,bounded));if(!active||destroyed||token!==generation)return false;
    capability=wealthEntryCapability(value,href(),{assetId:asset,now:now()});
    if(isLocal){phase=capability.state==='local-test'?'ready':'unavailable';return phase==='ready';}
    if(capability.state!=='cloud-readonly')throw Error('MARKET_INVALID');
    if(!response.ok||value.status!=='observed'){marketError=value.error||'MARKET_UNAVAILABLE';phase='unavailable';return false;}
    observation=value.observation;phase='ready';expiryTimer=setTimeout(()=>{expiryTimer=null;paint();},Math.max(1,Math.min(2147483647,observation.asOf+180001-now())));expiryTimer.unref?.();return true;
   }catch(error){if(token===generation&&active&&!destroyed){capability={state:'unavailable',realFundingEnabled:false};phase='unavailable';observation=null;marketError=timedOut?'MARKET_TIMEOUT':error?.code||error?.message||'MARKET_UNAVAILABLE';}return false;}
  })().finally(()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);if(token===generation){request=null;controller=null;paint();}});return request;
 }
 async function openTest(){
  if(!active||destroyed||phase!=='ready'||capability.state!=='local-test')return false;
  if(mode==='local')return true;
  const token=generation;phase='opening';paint();
  try{
   const module=await loadView();if(!active||destroyed||token!==generation)return false;
   syncURL();childHost=root.ownerDocument.createElement('div');
   child=module.createAIWealth({root:childHost,dialog,show,notify,storage,onChange(){if(!child||!active)return;childHost.innerHTML=child.render();child.bind();}});
   mode='local';phase='ready';paint();childHost.innerHTML=child.render();child.bind();return true;
  }catch{stopChild();mode='preview';phase='unavailable';capability={state:'unavailable',realFundingEnabled:false};paint();return false;}
 }
 function leave(){active=false;cancelCheck();stopChild();mode='preview';phase='idle';capability={state:'unavailable',realFundingEnabled:false};}
 function click(event){
  if(!active||destroyed)return;const choice=event.target.closest('[data-wealth-entry-profile]');
  if(choice&&root.contains(choice)){const previous=assetId;selected=profile(choice.dataset.wealthEntryProfile).id;assetId=current().defaultAssetId;syncURL();if(!localTest()&&previous!==assetId){cancelCheck();void check();}else paint();root.querySelector(`[data-wealth-entry-profile="${selected}"]`)?.focus({preventScroll:true});return;}
  const assetChoice=event.target.closest('[data-wealth-entry-asset]');
  if(assetChoice&&root.contains(assetChoice)&&current().assetIds.includes(assetChoice.dataset.wealthEntryAsset)&&assetChoice.dataset.wealthEntryAsset!==assetId){assetId=assetChoice.dataset.wealthEntryAsset;syncURL();cancelCheck();void check();root.querySelector(`[data-wealth-entry-asset="${assetId}"]`)?.focus({preventScroll:true});return;}
  const button=event.target.closest('[data-wealth-entry-action]');if(!button||!root.contains(button)||button.disabled)return;
  if(button.dataset.wealthEntryAction==='retry'&&phase!=='loading')void check();
  if(button.dataset.wealthEntryAction==='test')void openTest();
  if(button.dataset.wealthEntryAction==='back'){generation++;stopChild();mode='preview';phase='idle';paint();void check();}
 }
 readRoute();root.addEventListener('click',click);
 return {render,async ready(){if(!active){active=true;}return check();},bind(){if(destroyed||!root.querySelector('[data-wealth-entry]'))return;active=true;if(mode==='local'){mountChild();return;}if(phase==='idle')void check();},leave,destroy(){leave();destroyed=true;root.removeEventListener('click',click);},check,openTest,state};
}
