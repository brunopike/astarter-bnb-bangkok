export const WEALTH_AS_OF='2026-11-11';
const SCALE=1_000_000;
const valid=value=>Number.isFinite(value)&&value>=0;

export function performanceFee({shares,nav,highWaterMark,rate}){
 if(![shares,nav,highWaterMark,rate].every(valid)||shares<=0||rate>1)throw new Error('Invalid fee inputs');
 const gain=Math.max(0,nav-highWaterMark),fee=Math.floor(gain*shares*rate*SCALE)/SCALE;
 const netNav=nav-fee/shares;
 return {fee,netNav,nextHighWaterMark:Math.max(highWaterMark,netNav)};
}

export function parseWealthAmount(value){
 if(typeof value!=='string'||!/^\d+(?:\.\d{1,6})?$/.test(value.trim()))throw new Error('AMOUNT');
 const [whole,fraction='']=value.trim().split('.'),units=Number(whole)*SCALE+Number(fraction.padEnd(6,'0'));
 if(!Number.isSafeInteger(units)||units<=0)throw new Error('AMOUNT');
 return units;
}

export function productQuote(product){
 const pools=product.allocations.filter(row=>row.source!=='cash').map(row=>YIELD_POOLS.find(pool=>pool.id===row.source));
 const metric=pools.some(pool=>pool.metric==='APR')?'APR':'APY';
 return {rate:product.allocations.reduce((sum,row)=>sum+(row.source==='cash'?0:YIELD_POOLS.find(pool=>pool.id===row.source).apy)*row.weight/100,0),metric};
}

export function wealthAssetGroups(products){
 const groups=new Map();
 for(const product of products){
  if(!groups.has(product.asset))groups.set(product.asset,{asset:product.asset,products:[],researchCount:0,quotes:new Map()});
  const group=groups.get(product.asset);group.products.push(product);
  if(product.status==='research')group.researchCount++;
  if(product.status!=='proposal')continue;
  const quote=productQuote(product);if(!Number.isFinite(quote.rate))continue;
  const range=group.quotes.get(quote.metric);
  if(range){range.min=Math.min(range.min,quote.rate);range.max=Math.max(range.max,quote.rate);}
  else group.quotes.set(quote.metric,{metric:quote.metric,min:quote.rate,max:quote.rate});
 }
 return [...groups.values()].map(group=>({...group,quotes:[...group.quotes.values()]}));
}

export const CEX_EARN_REFERENCES=[
 {id:'binance',name:'Binance Earn',url:'https://www.binance.com/zh-CN/earn',asset:'USDC',quote:'8.98%',metric:'APR',product:['赚币 · 活期展示','Simple Earn · Flexible display'],terms:['最高展示；额度、资格与加息条件须在平台核对','Advertised maximum; verify limits, eligibility and bonus terms'],risk:['中心化托管与平台信用风险','Custody and platform credit risk']},
 {id:'okx',name:'OKX Earn',url:'https://www.okx.com/zh-hans/earn',asset:'USDC',quote:'10.00%',metric:'',product:['简单赚币 · 奖励展示','Simple Earn · Bonus display'],terms:['页面年化；含奖励，非全额基础利率','Displayed annualised rate includes rewards; not an uncapped base rate'],risk:['托管风险；链上赚币另有协议风险','Custody risk; on-chain products also carry protocol risk']},
 {id:'bybit',name:'Bybit Earn',url:'https://www.bybit.com/en/earn/home/',asset:'USDC',quote:'2.00–9.04%',metric:'APR',product:['Easy Earn · 活期 / 定期','Easy Earn · Flexible / Fixed'],terms:['不同期限与条件的区间；以当次申购为准','Range across terms and conditions; verify the subscription quote'],risk:['托管、限额与产品规则风险','Custody, limits and product-term risk']},
 {id:'bitget',name:'Bitget Earn',url:'https://www.bitget.com/zh-CN/finance',asset:'USDC',quote:'1.47–11.00%',metric:'APR',product:['简单赚币 / 现金宝','Simple Earn / Cash Plus'],terms:['页面聚合区间；不同产品与加息条件分开核对','Aggregated display; verify each product and bonus condition'],risk:['平台承诺不替代托管与兑付风险核查','Platform claims do not remove custody or repayment risk']}
];

export function forecastWealth(product,{amount,days,annualRate=productQuote(product).rate,metric=productQuote(product).metric,highWaterMark=1}){
 if(!Number.isFinite(amount)||amount<=0||!Number.isInteger(days)||days<1||days>product.maxDays||!Number.isFinite(annualRate)||annualRate<=-100||annualRate>1000||!valid(highWaterMark))throw new Error('FORECAST');
 const grossProfit=amount*(metric==='APR'?annualRate/100*days/365:Math.pow(1+annualRate/100,days/365)-1);
 // This estimate uses initial capital; live fees must accrue against daily NAV.
 const managementFee=amount*product.managementRate*days/365,nav=(amount+grossProfit-managementFee)/amount;
 if(nav<0)throw new Error('FORECAST');
 const fee=performanceFee({shares:amount,nav,highWaterMark,rate:product.performanceRate});
 return {grossProfit,managementFee,performanceFee:fee.fee,netProfit:grossProfit-managementFee-fee.fee,finalValue:amount+grossProfit-managementFee-fee.fee,highWaterMark:fee.nextHighWaterMark};
}

const STORE_KEY='astarter.wealth.paper.v1';
const initial=()=>({version:1,revision:0,cash:{USDC:10000*SCALE,ETH:10*SCALE,SOL:100*SCALE},positions:[],events:[]});
const validUnits=value=>Number.isSafeInteger(value)&&value>=0;
export function createWealthStore(storage){
 function read(){
  const raw=storage.getItem(STORE_KEY);if(raw===null)return initial();
  const state=JSON.parse(raw);
  if(state.version!==1||!validUnits(state.revision)||!['USDC','ETH','SOL'].every(asset=>validUnits(state.cash?.[asset]))||!Array.isArray(state.positions)||!Array.isArray(state.events)||state.positions.some(lot=>!WEALTH_PRODUCTS.some(product=>product.id===lot.productId)||typeof lot.id!=='string'||!validUnits(lot.units)||lot.units===0||lot.highWaterMark!==1))throw new Error('STORAGE');
  if(state.events.some(event=>{const product=WEALTH_PRODUCTS.find(row=>row.id===event?.productId);return !product||!['deposit','redeem'].includes(event.kind)||event.asset!==product.asset||!validUnits(event.units)||event.units===0||!Number.isFinite(event.at)||event.at<0;}))throw new Error('STORAGE');
  return state;
 }
 function save(state){
  const raw=JSON.stringify(state);storage.setItem(STORE_KEY,raw);
  if(storage.getItem(STORE_KEY)!==raw)throw new Error('STORAGE');
  return state;
 }
 // shortcut: localStorage is an isolated UI simulation, replace with an idempotent service ledger for real funds.
 return {read,deposit(productId,amount,now=Date.now()){
  const product=WEALTH_PRODUCTS.find(row=>row.id===productId);if(!product||product.status==='research')throw new Error('UNAVAILABLE');
  const units=parseWealthAmount(amount),state=read();
  if(units<product.minimum*SCALE)throw new Error('MINIMUM');if(units>state.cash[product.asset])throw new Error('BALANCE');
  const id='paper-'+(state.revision+1);state.cash[product.asset]-=units;state.revision++;
  state.positions.push({id,productId,units,highWaterMark:1,createdAt:now});
  state.events.push({id:'event-'+state.revision,kind:'deposit',productId,asset:product.asset,units,at:now});return save(state);
 },redeem(lotId,amount,now=Date.now()){
  const units=parseWealthAmount(amount),state=read(),lot=state.positions.find(row=>row.id===lotId);if(!lot)throw new Error('POSITION');
  if(units>lot.units)throw new Error('BALANCE');const product=WEALTH_PRODUCTS.find(row=>row.id===lot.productId);
  lot.units-=units;state.cash[product.asset]+=units;state.revision++;
  state.positions=state.positions.filter(row=>row.units>0);
  state.events.push({id:'event-'+state.revision,kind:'redeem',productId:product.id,asset:product.asset,units,at:now});return save(state);
 }};
}

export const YIELD_POOLS=[
 {"id":"Y01","name":"Aave V3","chain":"Ethereum","asset":"USDC","apy":3.77772,"base":3.77772,"reward":null,"mean30d":4.20499,"metric":"APY","url":"https://defillama.com/yields/pool/aa70268e-4b52-42bf-a116-608b370f9501","risk":"取出取决于可用流动性；合约、坏账与稳定币风险","kind":"浮动借贷","pool":"aa70268e-4b52-42bf-a116-608b370f9501","kindEn":"Variable-rate lending"},
 {"id":"Y02","name":"Morpho · GTUSDCP","chain":"Base","asset":"GTUSDCP","apy":4.95338,"base":4.95338,"reward":0,"mean30d":5.22942,"metric":"APY","url":"https://defillama.com/yields/pool/e0672197-9f3e-4414-bca5-e6b4c90aa469","risk":"退出取决于市场与金库可用流动性；不能只看 Morpho 品牌","kind":"策展借贷金库","pool":"e0672197-9f3e-4414-bca5-e6b4c90aa469","kindEn":"Curated lending vault"},
 {"id":"Y03","name":"Sky · sUSDS","chain":"Ethereum","asset":"SUSDS","apy":3.8,"base":3.8,"reward":null,"mean30d":3.8,"metric":"APY","url":"https://defillama.com/yields/pool/d8c4eff5-c8a9-46fc-a888-057c4c668e72","risk":"治理可调息；稳定币、协议与赎回路径风险","kind":"协议储蓄","pool":"d8c4eff5-c8a9-46fc-a888-057c4c668e72","kindEn":"Protocol savings"},
 {"id":"Y04","name":"Spark Savings · USDC","chain":"Ethereum","asset":"USDC","apy":3.8,"base":3.8,"reward":null,"mean30d":3.8,"metric":"APY","url":"https://defillama.com/yields/pool/c5c74dd1-995c-4445-9d84-3e710bad7d52","risk":"不能与 SparkLend 借贷池或 SPK 激励池混用","kind":"储蓄路由","pool":"c5c74dd1-995c-4445-9d84-3e710bad7d52","kindEn":"Savings allocation"},
 {"id":"Y05","name":"Fluid Lending","chain":"Ethereum","asset":"USDC","apy":4.39,"base":4.39,"reward":null,"mean30d":6.12717,"metric":"APY","url":"https://defillama.com/yields/pool/4438dabc-7f0c-430b-8136-2722711ae663","risk":"流动性、清算、协议及稳定币风险","kind":"浮动借贷","pool":"4438dabc-7f0c-430b-8136-2722711ae663","kindEn":"Variable-rate lending"},
 {"id":"Y06","name":"Euler V2 · Clearstar Earn USDC","chain":"Monad","asset":"USDC","apy":5.45102,"base":4.20102,"reward":1.25,"mean30d":8.4323,"metric":"APY","url":"https://defillama.com/yields/pool/d711af54-e736-470f-8a22-431a23de76df","risk":"金库/策展人/抵押品须分别准入；激励可结束","kind":"策展借贷","pool":"d711af54-e736-470f-8a22-431a23de76df","kindEn":"Curated lending"},
 {"id":"Y07","name":"Maple · Syrup USDC","chain":"Ethereum","asset":"USDC","apy":5.12319,"base":5.12319,"reward":0,"mean30d":5.13715,"metric":"APY","url":"https://defillama.com/yields/pool/43641cf5-a92e-416b-bce9-27113d3c0db6","risk":"借款方、抵押品、违约、管理人与赎回排队风险","kind":"机构信用收益","pool":"43641cf5-a92e-416b-bce9-27113d3c0db6","kindEn":"Institutional credit"},
 {"id":"Y08","name":"Ethena · sUSDe","chain":"Ethereum","asset":"SUSDE","apy":5.01138,"base":5.01138,"reward":null,"mean30d":5.01321,"metric":"APY","url":"https://defillama.com/yields/pool/66985a81-9c51-46ca-9977-42b4fe7bc6df","risk":"原生退出有冷却期；有资金费、交易对手及脱锚风险","kind":"合成美元收益","pool":"66985a81-9c51-46ca-9977-42b4fe7bc6df","kindEn":"Synthetic-dollar yield"},
 {"id":"Y09","name":"Pendle · PT-sUSDe 26NOV2026","chain":"Ethereum","asset":"SUSDE","apy":5.0991,"base":5.0991,"reward":null,"mean30d":4.90503,"metric":"APY","url":"https://defillama.com/yields/pool/fc9a73bc-8ccc-5701-9007-1aeb68ff6a51","risk":"2026-11-26 到期；提前退出按市价，底层与会计资产风险仍在","kind":"到期收益","pool":"fc9a73bc-8ccc-5701-9007-1aeb68ff6a51","kindEn":"Yield to maturity"},
 {"id":"Y10","name":"Pendle · PT-reUSD 10DEC2026","chain":"Ethereum","asset":"REUSD","apy":11.65611,"base":11.65611,"reward":null,"mean30d":11.98214,"metric":"APY","url":"https://defillama.com/yields/pool/7abaf885-bad2-4531-8550-37b2313f2f76","risk":"2026-12-10 到期；固定收益报价不等于美元本金保障","kind":"到期收益","pool":"7abaf885-bad2-4531-8550-37b2313f2f76","kindEn":"Yield to maturity"},
 {"id":"Y11","name":"Pendle · reUSD LP 10DEC2026","chain":"Ethereum","asset":"REUSD","apy":9.46489,"base":9.17877,"reward":0.28612,"mean30d":9.83274,"metric":"APY","url":"https://defillama.com/yields/pool/346fecdb-9749-4b75-9366-38bc24134e6f","risk":"不是 PT 固定收益；有 LP 定价、期限、激励和退出风险","kind":"收益流动性","pool":"346fecdb-9749-4b75-9366-38bc24134e6f","kindEn":"Yield liquidity"},
 {"id":"Y12","name":"Yearn Finance · Base USDC 样本","chain":"Base","asset":"USDC","apy":15.74034,"base":15.74034,"reward":0,"mean30d":5.99554,"metric":"APY","url":"https://defillama.com/yields/pool/ea721c71-9a61-481d-aa52-b0198f325c66","risk":"当前 15%+ 与历史均值差异显著；查明策略和收割口径","kind":"自动配置/复投","pool":"ea721c71-9a61-481d-aa52-b0198f325c66","kindEn":"Automated allocation / compounding","nameEn":"Yearn Finance · Base USDC sample"},
 {"id":"Y13","name":"Beefy · Ethereum USDC / Morpho","chain":"Ethereum","asset":"USDC","apy":5.10533,"base":null,"reward":null,"mean30d":5.63785,"metric":"APY","url":"https://defillama.com/yields/pool/45ecff73-d1b5-412f-ae15-c409034cc14c","risk":"叠加封装层风险；本快照未拆基础与激励，不能当作零激励","kind":"自动复投","pool":"45ecff73-d1b5-412f-ae15-c409034cc14c","kindEn":"Auto-compounding"},
 {"id":"Y14","name":"Superform · SuperUSDC / Ethereum","chain":"Ethereum","asset":"SUPERUSDC","apy":8.90305,"base":5.47686,"reward":3.4262,"mean30d":8.47477,"metric":"APY","url":"https://defillama.com/yields/pool/fbd2a90a-f18f-412f-9f75-cc75432efd3f","risk":"份额估值、管理权限与异步赎回；具体版本不能混用","kind":"多策略金库","pool":"fbd2a90a-f18f-412f-9f75-cc75432efd3f","kindEn":"Multi-strategy vault"},
 {"id":"Y15","name":"YO Protocol · yoUSD / Base","chain":"Base","asset":"USDC","apy":4.196,"base":4.196,"reward":null,"mean30d":4.80425,"metric":"APY","url":"https://defillama.com/yields/pool/1994cc35-a2b9-434e-b197-df6742fb5d81","risk":"管理、底层穿透、跨链/退出风险；首页宣传值未与本池核齐","kind":"自动收益优化","pool":"1994cc35-a2b9-434e-b197-df6742fb5d81","kindEn":"Yield optimisation"},
 {"id":"Y16","name":"Curve · USDC-RLUSD","chain":"Ethereum","asset":"USDC-RLUSD","apy":3.99549,"base":0.08,"reward":3.91549,"mean30d":4.90417,"metric":"APY","url":"https://defillama.com/yields/pool/e91e23af-9099-45d9-8ba5-ea5b4638e453","risk":"激励占主要部分；稳定币脱锚与 LP 净值可损失","kind":"稳定币 LP","pool":"e91e23af-9099-45d9-8ba5-ea5b4638e453","kindEn":"Stablecoin LP"},
 {"id":"Y17","name":"Convex · USDC-RLUSD","chain":"Ethereum","asset":"USDC-RLUSD","apy":4.22242,"base":null,"reward":4.22242,"mean30d":2.11038,"metric":"APY","url":"https://defillama.com/yields/pool/d826a92b-2bd2-4fae-8483-db1ef8888aee","risk":"与上行不是独立底层风险；字段未披露完整基础费收益","kind":"LP 激励增强","pool":"d826a92b-2bd2-4fae-8483-db1ef8888aee","kindEn":"LP incentive enhancement"},
 {"id":"Y18","name":"Kamino Lend · USDC / SOL-BTC market","chain":"Solana","asset":"USDC","apy":3.91912,"base":3.91912,"reward":null,"mean30d":4.89536,"metric":"APY","url":"https://defillama.com/yields/pool/d2141a59-c199-4be7-8d4b-c8223954836b","risk":"与 Kamino RWA、机构及杠杆产品区分；退出依流动性","kind":"Solana 借贷","pool":"d2141a59-c199-4be7-8d4b-c8223954836b","kindEn":"Solana lending"},
 {"id":"Y19","name":"Jupiter Lend · USDC Earn","chain":"Solana","asset":"USDC","apy":4.81188,"base":4.81188,"reward":null,"mean30d":6.25715,"metric":"APY","url":"https://defillama.com/yields/pool/d783c8df-e2ed-44b4-8317-161ccc1b5f06","risk":"利用率与协议/资产风险；不是 JLP 或 JupSOL","kind":"Solana 借贷","pool":"d783c8df-e2ed-44b4-8317-161ccc1b5f06","kindEn":"Solana lending"},
 {"id":"Y20","name":"Lido · stETH","chain":"Ethereum","asset":"STETH","apy":2.25063,"base":2.25063,"reward":null,"mean30d":2.66182,"metric":"APY","url":"https://defillama.com/yields/pool/747c1d2a-c668-4682-b9f9-296708a3dd90","risk":"ETH 本位；ETH 美元价格波动、罚没与退出队列","kind":"ETH 质押","pool":"747c1d2a-c668-4682-b9f9-296708a3dd90","kindEn":"ETH staking"},
 {"id":"Y21","name":"Jupiter · JupSOL","chain":"Solana","asset":"JUPSOL","apy":5.05715,"base":5.05715,"reward":null,"mean30d":5.17845,"metric":"APY","url":"https://defillama.com/yields/pool/52bd72a7-9e81-4112-abb4-71673e8de9bf","risk":"SOL 本位；币价、验证者与退出风险","kind":"SOL 质押","pool":"52bd72a7-9e81-4112-abb4-71673e8de9bf","kindEn":"SOL staking"},
 {"id":"Y22","name":"Ondo · USDY","chain":"Ethereum","asset":"USDY","apy":3.75,"base":3.75,"reward":null,"mean30d":3.7222,"metric":"APY","url":"https://defillama.com/yields/pool/ac61ee82-2fe4-4f9b-a9cd-7fb33f598859","risk":"发行、托管、资格、地域及赎回限制；不是所有钱包都能申赎","kind":"RWA 票据","pool":"ac61ee82-2fe4-4f9b-a9cd-7fb33f598859","kindEn":"RWA note"},
 {"id":"Y23","name":"OpenEden · TBILL","chain":"Ethereum","asset":"TBILL","apy":3.65908,"base":3.65908,"reward":null,"mean30d":3.64484,"metric":"APY","url":"https://defillama.com/yields/pool/e140f3b2-0327-46ea-93f5-88b17b0a0a16","risk":"需合格/专业投资者、KYC/KYT 与白名单；按基金规则结算","kind":"RWA 基金","pool":"e140f3b2-0327-46ea-93f5-88b17b0a0a16","kindEn":"RWA fund"},
 {"id":"Y24","name":"Centrifuge · Janus Henderson AAA CLO / USAT","chain":"Ethereum","asset":"USAT","apy":3.22486,"base":3.22486,"reward":null,"mean30d":5.04374,"metric":"APY","url":"https://defillama.com/yields/pool/246659c9-877b-5dcc-92c1-cbd7bfcf0d85","risk":"AAA 不是保本；结构化信用、净值、资格与赎回风险","kind":"RWA 结构化信用","pool":"246659c9-877b-5dcc-92c1-cbd7bfcf0d85","kindEn":"Structured credit"},
 {"id":"aave-base","name":"Aave V3 · Base USDC","chain":"Base","asset":"USDC","apy":7.16453,"base":5.36886,"reward":1.79567,"mean30d":6.21171,"metric":"APY","url":"https://defillama.com/yields/pool/7e0661bf-8cf3-45e6-9424-31916d4c7b84","risk":"底层资产、协议及退出风险；激励可能结束","kind":"补充池样本","pool":"7e0661bf-8cf3-45e6-9424-31916d4c7b84","kindEn":"Additional pool sample"},
 {"id":"morpho-eth","name":"Morpho · Ethereum GTUSDCP","chain":"Ethereum","asset":"GTUSDCP","apy":4.63315,"base":4.63315,"reward":0,"mean30d":4.86263,"metric":"APY","url":"https://defillama.com/yields/pool/71b34441-5a46-431b-a9b3-8c081cd0d74c","risk":"底层资产、协议及退出风险；激励可能结束","kind":"补充池样本","pool":"71b34441-5a46-431b-a9b3-8c081cd0d74c","kindEn":"Additional pool sample"},
 {"id":"beefy-fx","name":"Beefy · fxUSD-USDC","chain":"Ethereum","asset":"FXUSD-USDC","apy":16.85746,"base":null,"reward":null,"mean30d":11.91991,"metric":"APY","url":"https://defillama.com/yields/pool/72a2bad5-812e-4f90-bb1c-a4ccf76d270a","risk":"底层资产、协议及退出风险；激励可能结束","kind":"补充池样本","pool":"72a2bad5-812e-4f90-bb1c-a4ccf76d270a","kindEn":"Additional pool sample"},
 {"id":"hlp","name":"Hyperliquid HLP","chain":"Hyperliquid","asset":"USDC","apy":25.82182049615021,"base":25.82182049615021,"reward":null,"mean30d":null,"metric":"APR","url":"https://app.hyperliquid.xyz/vaults/0xdfc24b077bc1425ad1dea75bcb6f8158e10df303","risk":"做市/清算策略可亏损本金；最新存入后4日锁定","kind":"做市策略","kindEn":"Market making"},
 {"id":"loop-source","name":"PendleLoop · sUSDat / AUSD","chain":"Ethereum","asset":"sUSDat/AUSD","apy":79.48,"base":null,"reward":null,"mean30d":null,"metric":"APY","url":"https://app.pendle.finance/trade/loop","risk":"最高约6.3倍；信用份额、浮动借款和清算风险；预言机资料未齐","kind":"杠杆研究","kindEn":"Leveraged research"}
];

export const WEALTH_PRODUCTS=[
 {"id":"cash","name":["美元流动性","USD Liquidity"],"subtitle":["主流借贷 · 保留流动性","Core lending · Liquidity reserve"],"risk":"low","asset":"USDC","chain":"Base","managementRate":0.0035,"performanceRate":0.08,"minimum":100,"days":30,"allocations":[{"source":"aave-base","weight":45},{"source":"Y02","weight":45},{"source":"cash","weight":10}],"exit":["无固定锁期 · 依底层流动性","No fixed term · Subject to liquidity"],"logic":["比较借贷净收益，保留10%现金，不使用借款杠杆","Compare lending yields, retain 10% cash, and avoid borrowing"],"riskNote":["激励到期、借贷坏账、稳定币脱锚与金库权限风险","Incentive expiry, bad debt, stablecoin and vault permission risk"]},
 {"id":"reserve","name":["美元储蓄组合","Dollar Reserve"],"subtitle":["储蓄与借贷 · 单链配置","Savings and lending · One chain"],"risk":"low","asset":"USDC","chain":"Ethereum","managementRate":0.003,"performanceRate":0.08,"minimum":100,"days":30,"allocations":[{"source":"Y01","weight":40},{"source":"Y03","weight":40},{"source":"Y04","weight":20}],"exit":["无固定锁期 · 依兑换与流动性","No fixed term · Conversion and liquidity apply"],"logic":["分配到储蓄和借贷收益源，核对稳定币转换成本","Allocate to savings and lending after conversion costs"],"riskNote":["Sky与Spark存在共同依赖，不代表完全分散；有稳定币转换风险","Sky and Spark share dependencies; stablecoin conversion introduces risk"]},
 {"id":"income","name":["美元均衡收益","Balanced Dollar Income"],"subtitle":["多收益源 · 分散配置","Multiple income sources · Balanced allocation"],"risk":"medium","asset":"USDC","chain":"Ethereum","managementRate":0.006,"performanceRate":0.12,"minimum":100,"days":90,"allocations":[{"source":"morpho-eth","weight":35},{"source":"Y05","weight":25},{"source":"Y08","weight":30},{"source":"cash","weight":10}],"exit":["部分资产有冷却期","Some assets have an unstaking cooldown"],"logic":["在信用、借贷和合成美元收益间配置，合并共同敞口","Balance lending and synthetic-dollar income, consolidating shared exposures"],"riskNote":["USDe资金费、对手方与脱锚风险；冷却期影响退出","USDe funding, counterparty and depeg risks; cooldown affects exits"]},
 {"id":"maturity","name":["到期收益阶梯","Maturity Ladder"],"subtitle":["Pendle PT · 分期到期","Pendle PT · Staggered maturities"],"risk":"medium","asset":"USDC","chain":"Ethereum","managementRate":0.006,"performanceRate":0.12,"minimum":100,"days":14,"maxDays":14,"maturities":["2026-11-26","2026-12-10"],"allocations":[{"source":"Y09","weight":35},{"source":"Y10","weight":45},{"source":"cash","weight":20}],"exit":["提前退出按市价 · 到期兑换依底层","Market price before maturity · Redemption subject to underlying"],"logic":["以到期日匹配用钱时间；首期到期后重新评估，不自动外推年化","Match maturities to cash needs; re-evaluate at the first maturity"],"riskNote":["PT固定的是具体会计资产收益，仍有底层信用与转换风险","PT return is denominated in its accounting asset; credit and conversion risks remain"]},
 {"id":"eth","name":["ETH 质押配置","ETH Staking"],"subtitle":["ETH本位 · 质押与流动储备","ETH denominated · Staking and liquidity"],"risk":"high","asset":"ETH","chain":"Ethereum","managementRate":0.0025,"performanceRate":0.08,"minimum":0.05,"days":90,"allocations":[{"source":"Y20","weight":90},{"source":"cash","weight":10}],"exit":["原生退出可能排队","Native unstaking may require a queue"],"logic":["以增加ETH数量为目标，保留同币种流动性","Target ETH accumulation with a same-asset liquidity reserve"],"riskNote":["ETH美元价格波动、罚没、LST折价和退出队列风险","ETH price volatility, slashing, LST discounts and withdrawal queues"]},
 {"id":"sol","name":["SOL 质押配置","SOL Staking"],"subtitle":["SOL本位 · 验证者收益","SOL denominated · Validator rewards"],"risk":"high","asset":"SOL","chain":"Solana","managementRate":0.0035,"performanceRate":0.1,"minimum":1,"days":90,"allocations":[{"source":"Y21","weight":90},{"source":"cash","weight":10}],"exit":["按原生质押或市场流动性退出","Exit through native staking or market liquidity"],"logic":["以SOL数量计量收益，独立核对验证者与退出成本","Measure returns in SOL and review validator and exit costs"],"riskNote":["SOL币价、验证者、合约与链运行风险","SOL price, validator, contract and network risk"]},
 {"id":"liquidity","name":["流动性收益精选","Liquidity Income"],"subtitle":["稳定币LP · 费用与激励","Stablecoin LPs · Fees and incentives"],"risk":"high","asset":"USDC","chain":"Ethereum","managementRate":0.009,"performanceRate":0.18,"minimum":100,"days":30,"allocations":[{"source":"Y16","weight":45},{"source":"beefy-fx","weight":35},{"source":"cash","weight":20}],"exit":["市价退出 · 可能产生滑点","Market exit · Slippage may apply"],"logic":["比较交易费与奖励，监测脱锚与激励衰减","Compare fees and rewards while monitoring depegs and incentive decay"],"riskNote":["稳定币脱锚、无常损失、激励价格与包装层风险","Stablecoin depegs, impermanent loss, incentive prices and wrapper risk"]},
 {"id":"market-making","name":["做市风险溢价","Market-Making Premium"],"subtitle":["HLP · 做市与清算收益","HLP · Market making and liquidations"],"risk":"high","asset":"USDC","chain":"Hyperliquid","managementRate":0.012,"performanceRate":0.2,"minimum":100,"days":30,"allocations":[{"source":"hlp","weight":80},{"source":"cash","weight":20}],"exit":["HLP最新存入后锁定4日","HLP locks for 4 days after the latest deposit"],"logic":["独立承担做市盈亏，保留现金，不把交易盈亏当固定利息","Accept market-making PnL and keep cash; returns are not fixed interest"],"riskNote":["对手盘和清算压力下净值可快速下降","NAV may fall sharply under counterparty and liquidation stress"]},
 {"id":"loop","name":["循环收益观察","Leveraged Yield Watch"],"subtitle":["PendleLoop · 尚待准入核查","PendleLoop · Due diligence pending"],"risk":"high","asset":"USDC","chain":"Ethereum","managementRate":0.012,"performanceRate":0.2,"minimum":100,"days":14,"status":"research","allocations":[{"source":"loop-source","weight":100}],"exit":["需先减杠杆还债，退出受流动性约束","Deleverage and repay first; liquidity limits apply"],"logic":["先核齐底层收益、债务利率与预言机，再决定是否建立产品","Reconcile underlying yield, borrowing rates and oracle data before admission"],"riskNote":["sUSDat是STRC信用份额；79.48%为最大循环估值，非存款利率","sUSDat carries STRC credit exposure; 79.48% is a maximum looping estimate"]}
].map((product,index)=>({code:'AST-W'+String(index+1).padStart(2,'0'),principalProtected:false,status:'proposal',maxDays:365,...product}));
