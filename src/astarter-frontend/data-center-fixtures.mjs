// Deterministic local fixtures. No remote quotes, news, addresses, or model calls.
import {ASSETS} from './product-data.mjs';
export const SNAPSHOT='2026-10-24 14:00';
export const DATA_PAGES=['markets','tracking','intelligence','social','derivatives','etf'];
export function wave(base,seed=1,n=90,variation=.08){let s=seed>>>0,walk=0;const values=Array.from({length:n},(_,i)=>{s=(Math.imul(s,1664525)+1013904223)>>>0;walk+=(s/4294967296-.48)*variation*.2;return base*(1+walk+Math.sin(i*.17+seed)*variation*.3);});return values.map((v,i)=>i===values.length-1?base:v*base/values.at(-1));}
export const MARKET=ASSETS.map(([symbol,name,domain,unit,price],i)=>{const series=wave(price,i+39,168,.08),change=(price/series.at(-25)-1)*100;return {symbol,name,domain,unit,price,series,change,volume:[16840,8240,2130,0,0,0,0,0][i],oi:[27400,13100,2400][i]??null,oiChange:[2.8,-1.4,6.2][i]??null,funding:[.0081,-.0024,.0142][i]??null,long:[52.4,48.2,57.1][i]??null,liquidation:[42.6,19.8,6.4][i]??null,color:['#f1a523','#627eea','#9879e9','#4b8dbd','#5a70d3','#c99c45','#38a18d','#a27cba'][i]};});
const extraAssets=[
 ['BNB','BNB',596.4,1260,990,86800,'Layer 1','#e5ad30'],['XRP','XRP',.531,1590,1320,30200,'支付','#5685b0'],['DOGE','Dogecoin',.146,980,730,21400,'Meme','#c9a63e'],['TON','Toncoin',5.18,380,265,13400,'Layer 1','#339bc9'],['ADA','Cardano',.359,310,280,12600,'Layer 1','#5476c5'],['AVAX','Avalanche',28.51,425,392,11600,'Layer 1','#e26871'],['LINK','Chainlink',12.14,530,345,7600,'DeFi','#537bd8'],['DOT','Polkadot',4.27,230,180,6400,'Layer 1','#df6bad'],['SUI','Sui',2.04,890,650,5800,'Layer 1','#6cabe3'],['NEAR','NEAR Protocol',4.82,610,310,5400,'AI','#63b99e'],['UNI','Uniswap',7.93,220,175,4800,'DeFi','#d65a94'],['APT','Aptos',9.4,540,367,4700,'Layer 1','#5ea9a3'],['AAVE','Aave',152.8,302,192,2300,'DeFi','#9c7ac5'],['INJ','Injective',20.35,190,110,1980,'DeFi','#75a8e4'],['RENDER','Render',5.44,240,158,2810,'AI','#cc6273'],['TAO','Bittensor',508.2,270,196,3750,'AI','#999ca8'],['WIF','dogwifhat',2.31,420,249,2310,'Meme','#b88f6a'],['PEPE','Pepe',.0000093,670,299,3910,'Meme','#67aa6a'],['ARB','Arbitrum',.543,180,190,2200,'Layer 2','#76acdc'],['OP','Optimism',1.59,190,128,2080,'Layer 2','#d26d6b'],['HYPE','Hyperliquid',24.18,680,540,8100,'DeFi','#6cbca7']
];
for(const [i,[symbol,name,price,volume,oi,marketCap,sector,color]] of extraAssets.entries()){
 const series=wave(price,181+i,168,.18);MARKET.push({symbol,name,domain:'Crypto',unit:'USD',price,volume,oi,marketCap,sector,color,series,change:(price/series.at(-25)-1)*100,oiChange:Math.sin(i*1.7)*12,funding:Math.cos(i*.8)*.021,long:43+(i*7)%18,liquidation:Math.round(volume*.005*10)/10});
}
for(const [i,a] of MARKET.entries())Object.assign(a,{rank:i+1,sector:a.sector||(a.symbol==='BTC'?'PoW':a.symbol==='ETH'?'Layer 1':a.domain==='TradFi'?'TradFi':'Layer 1'),marketCap:a.marketCap??({BTC:1610000,ETH:382000,SOL:86500}[a.symbol]??null),volumeChange:a.volume?Math.sin(i+2)*23:null,oiHour:a.oi?Math.cos(i+3)*2.6:null,rsi:Math.round(36+(Math.sin(i*.7)+1)*16),change4h:(a.price/a.series.at(-5)-1)*100,change30m:(a.price/a.series.at(-2)-1)*35,change5m:(a.price/a.series.at(-2)-1)*7});
export const CRYPTO=MARKET.filter(a=>a.domain==='Crypto');
export const METRICS=[
 ['accumulation','持续增持账户持币量','持币与供给',3420000,'BTC','BTC','持续增加余额的账户所持 BTC 总量。账户行为分类不代表真实持有人身份。','余额增长与交易所流出同时出现，值得继续观察。','转账可能是内部归集；不能直接当作新增买盘。'],
 ['exchange-balance','交易所 BTC 余额','交易所资金',2310000,'BTC','BTC','标记交易所地址的 BTC 余额总和，受标签覆盖影响。','余额减少时，结合成交量观察可交易供给变化。','地址标签不完整，冷钱包调整也会造成变化。'],
 ['exchange-netflow','交易所净流入','交易所资金',-2840,'BTC','BTC','观察窗口内流入减流出；正数为净流入。','净流出形成供给线索，尚不能判断交易方向。','提币不等于买入，充值也不等于卖出。'],
 ['active','活跃地址数','网络活动',832000,'地址','BTC','每日参与转账的去重地址数量，不等同于人数。','活跃度与转账金额一起看，判断变化是否持续。','单一实体可拥有多个地址，也可能出现批量转账。'],
 ['transactions','每日转账笔数','网络活动',476000,'笔','BTC','链上已记录的每日交易笔数。','活动增强需要和手续费、金额交叉观察。','笔数增长不一定意味着投资需求增加。'],
 ['fees','网络手续费','网络活动',26.8,'BTC','BTC','网络每日交易手续费合计。','手续费回升，检查网络使用是否同步增加。','拥堵与短期批量操作可能放大变化。'],
 ['mvrv','市值 / 已实现市值','成本与估值',2.14,'倍','BTC','当前市值与按最后移动价格计算的已实现市值之比。','相对持币成本偏高，关注追涨后的回撤空间。','历史分位不能预测顶部，结构变化会影响解释。'],
 ['sopr','已花费输出盈亏比','成本与估值',1.024,'倍','BTC','已花费输出在移动时的价格与取得时价格的比值。','样本高于 1，说明移动币中有获利兑现线索。','币的移动并不必然对应交易所成交。'],
 ['realized-price','已实现价格','成本与估值',37980,'USD','BTC','以币最后移动价格估计的全网平均链上成本。','现价高于估计成本；用作周期背景。','不是所有人的真实买入成本。'],
 ['whales','大额转账数量','大额转账',286,'笔','ETH','单笔超过样例金额阈值的链上转账。','大额转账聚集，先辨认去向再判断影响。','内部归集、跨链与交易不能混为一谈。'],
 ['stablecoins','稳定币流入','交易所资金',128,'百万 USD','ETH','样例交易所地址的稳定币净流入。','潜在可用资金增加，需等待成交侧确认。','资金进入交易所不保证会买入风险资产。'],
 ['staked','质押中的 ETH','持币与供给',34800000,'ETH','ETH','样例质押合约内的 ETH 数量。','观察新增质押与退出队列是否背离。','质押变化不直接等同于价格方向。']
].map(([id,name,category,value,unit,asset,description,observation,caution],i)=>{const series=wave(Math.abs(value),i+115,180,.13).map(v=>value<0?-v:v);return {id,name,category,value,unit,asset,description,observation,caution,series,change:(value/series.at(-2)-1)*100};});
const additionalMetrics=[
 ['supply','流通供应量','持币与供给',19780000,'BTC','BTC','已发行且进入流通口径的比特币总量。'],
 ['illiquid','非流动供应量','持币与供给',14600000,'BTC','BTC','按历史收支行为分类为低流动实体的余额。分类依赖地址聚类方法。'],
 ['profit-supply','盈利供应占比','持币与供给',83.4,'%','BTC','最后移动价格低于现价的币占流通量比例。'],
 ['lth-supply','长期持有者供应量','持有人分组',13920000,'BTC','BTC','超过 155 天未发生链上移动的币量。'],
 ['sth-supply','短期持有者供应量','持有人分组',5860000,'BTC','BTC','币龄不超过 155 天的币量。'],
 ['whale-balance','千枚以上地址余额','持有人分组',6230000,'BTC','BTC','余额超过 1,000 BTC 的地址合计余额。地址不等于个人。'],
 ['shrimp','小额地址余额','持有人分组',1280000,'BTC','BTC','余额小于 1 BTC 的地址合计余额。'],
 ['new-address','新增地址数','地址与实体',384000,'地址','BTC','首次在链上接收 BTC 的地址数量。'],
 ['nonzero','非零余额地址数','地址与实体',54100000,'地址','BTC','当前有非零余额的地址数。'],
 ['active-entities','活跃实体数','地址与实体',286000,'实体','BTC','按样例聚类方法估算的活跃实体，不等于实际用户人数。'],
 ['realized-cap','已实现市值','成本与估值',751220,'百万 USD','BTC','将每枚币按最后移动时价格计价并求和。'],
 ['nupl','未实现净盈亏比例','成本与估值',.52,'比率','BTC','市值减已实现市值后，再除以市值。'],
 ['lth-cost','长期持有者成本','成本与估值',28950,'USD','BTC','长期持有币的已实现成本估计。'],
 ['sth-cost','短期持有者成本','成本与估值',73400,'USD','BTC','短期持有币的已实现成本估计。'],
 ['spent-volume','已花费币量','行为与盈亏',281000,'BTC','BTC','当日作为交易输入被花费的 BTC 总量。'],
 ['realized-profit','链上已实现盈利','行为与盈亏',482,'百万 USD','BTC','按币最后移动价格计算的当日已实现盈利。'],
 ['realized-loss','链上已实现亏损','行为与盈亏',92,'百万 USD','BTC','按币最后移动价格计算的当日已实现亏损绝对值。'],
 ['cdd','币天销毁','行为与盈亏',6840000,'币天','BTC','被花费币数量乘以持有天数，用于观察老币活动。'],
 ['transfer-volume','链上转移金额','转账活动',12840,'百万 USD','BTC','样例去除已识别内部转移后的链上转账金额。'],
 ['transfer-median','单笔转账中位数','转账活动',1268,'USD','BTC','转账金额分布的中位数，避免大额交易拉高均值。'],
 ['exchange-inflow','交易所流入量','交易所资金',14280,'BTC','BTC','流入已标记交易所地址的数量。'],
 ['exchange-outflow','交易所流出量','交易所资金',17120,'BTC','BTC','从已标记交易所地址流出的数量。'],
 ['eth-exchange','交易所 ETH 余额','交易所资金',17800000,'ETH','ETH','样例标签覆盖下交易所 ETH 余额。'],
 ['stable-supply','稳定币供应量','稳定币与质押',168200,'百万 USD','ETH','样例所覆盖稳定币的链上流通规模。'],
 ['validator-queue','验证者退出队列','稳定币与质押',26800,'ETH','ETH','已申请退出但尚未完成退出的 ETH 数量。'],
 ['gas','Gas 均价','手续费与区块',8.4,'Gwei','ETH','样例区块中支付 Gas 单价的均值。'],
 ['block-fees','平均单笔费用','手续费与区块',1.83,'USD','BTC','每日总手续费除以交易数量。'],
 ['block-size','平均区块大小','手续费与区块',1.68,'MB','BTC','每日已确认区块大小的平均值。'],
 ['hashrate','全网算力','挖矿',682,'EH/s','BTC','根据难度和出块时间推算的网络算力。'],
 ['difficulty','挖矿难度','挖矿',92.1,'T','BTC','当前区块难度参数，T 为万亿量级。'],
 ['miner-balance','矿工地址余额','挖矿',1810000,'BTC','BTC','已识别矿工地址余额总量。'],
 ['miner-revenue','矿工每日收入','挖矿',29.8,'百万 USD','BTC','区块补贴加手续费，按当日价格换算。'],
 ['mempool','待确认交易数','内存池',18420,'笔','BTC','样例节点当前内存池中的交易数量。'],
 ['mempool-size','内存池交易大小','内存池',43.2,'MB','BTC','样例节点待确认交易的合计大小。'],
 ['lightning','闪电网络容量','支付网络',5240,'BTC','BTC','可见公开通道的 BTC 容量，不包含私有通道。'],
 ['channels','公开支付通道数','支付网络',64200,'通道','BTC','可见且活跃的公开闪电网络通道数量。']
];
for(const [i,[id,name,category,value,unit,asset,description]] of additionalMetrics.entries()){
 const series=wave(value,290+i,365,.18);METRICS.push({id,name,category,value,unit,asset,description,observation:`${name}的近期变化需与价格和资金方向一起观察。`,caution:'统计依赖地址标签与数据覆盖，单一指标不能确认交易方向。',series,change:(value/series.at(-2)-1)*100});
}
for(const m of METRICS){m.type=m.category==='持有人分组'?'分组':m.category==='成本与估值'?'成本估值':'单指标';m.start='2026-01-01';}
export const NEWS=[
 ['n1','14:00','宏观','利率决议窗口临近，关注美元与风险资产的同步变化','演示日历在今晚安排了一次利率事件。研究组将比较美元、国债收益率与加密资产的反应，暂不把单条消息变成买卖结论。',['DXY','US10Y','BTC'],true,'等待事件公布后再检查波动和成交量，避免只凭预期判断方向。'],
 ['n2','13:42','资金','现货 ETF 样本出现连续净流入','模拟资金表连续三个交易日录得净流入，今天的增量集中在两个基金样本。需要同时观察价格是否跟随。',['BTC'],true,'资金流向可提供背景，ETF 申赎并不等同于当时的现货成交。'],
 ['n3','13:25','链上','一组地址出现大额转账，接收方身份尚不明确','样例记录显示三笔转账，暂未确认交易所标签。研究组保留线索，等待地址归属与交易类型补全。',['ETH'],false,'先查来源和去向；不把转账直接解读成卖出。'],
 ['n4','12:58','宏观','美元走弱，黄金与股指反应并不一致','在这个模拟情景中，美元指数下行，黄金抬升，而股指短暂回落。跨市场相关性并非固定。',['DXY','XAU','SPX'],false,'同时查看收益率，区分避险变化与风险偏好变化。'],
 ['n5','12:36','市场','合约持仓上升，资金费率开始分化','样例中 SOL 持仓增长快于 BTC，部分合约费率上行。成交量和价格尚未形成一致方向。',['SOL','BTC'],true,'先观察拥挤程度，不把持仓增加当作单边看涨。'],
 ['n6','12:10','舆情','同一条消息被多次转发，去重后讨论热度回落','原始样本 120 条讨论中有 78 条内容重复。保留独立来源后，讨论的广度明显缩小。',['SOL'],false,'传播量与独立观点分开看，等待可验证出处。'],
 ['n7','11:48','市场','成交量回升，价格仍在观察区间内','样例行情出现放量，但价格尚未离开观察区间，研究组继续等待边界附近的反应。',['BTC','ETH'],false,'突破前先看成交持续性，并准备失效后的处理方式。']
].map(([id,time,category,title,body,assets,important,impact])=>({id,time,category,title,body,assets,important,impact,source:'HIVE 情景样本'}));
export const CALENDAR=[
 {day:24,time:'20:30',name:'就业数据发布',area:'美国',impact:'高',assets:['US10Y','DXY'],previous:'22.1 万',expected:'18.5 万'},
 {day:24,time:'22:00',name:'消费者信心',area:'美国',impact:'中',assets:['SPX'],previous:'98.2',expected:'99.0'},
 {day:25,time:'02:00',name:'利率决议',area:'美国',impact:'高',assets:['BTC','XAU','DXY'],previous:'4.50%',expected:'4.50%'},
 {day:26,time:'16:00',name:'制造业景气调查',area:'欧元区',impact:'中',assets:['DXY'],previous:'48.7',expected:'49.0'}];
export const TRADERS=[
 {id:'north',name:'North / 趋势观察',initial:'N',color:'#7b6bd4',style:'趋势跟踪',bio:'示例交易员，观察价格结构与仓位变化。',assets:['BTC','ETH'],pnl:8.4,drawdown:5.2,days:90},
 {id:'river',name:'River / 链上笔记',initial:'R',color:'#2b9e8c',style:'链上研究',bio:'示例研究者，关注流入流出与地址活动。',assets:['ETH','SOL'],pnl:4.8,drawdown:8.1,days:60},
 {id:'delta',name:'Delta / 宏观交易',initial:'D',color:'#c08c40',style:'宏观观察',bio:'示例交易员，比较利率、美元和加密市场。',assets:['BTC','XAU'],pnl:-2.3,drawdown:9.6,days:120}];
export const POSTS=[
 {id:'p1',trader:'north',time:'13:54',kind:'持仓变化',asset:'BTC',text:'减少 BTC 多头仓位，保留一部分，等待区间上沿的后续反应。',side:'多头',before:24,after:18,leverage:2,impact:'这是减仓，不是转为空头。先比较总仓位和剩余风险。'},
 {id:'p2',trader:'river',time:'13:38',kind:'研究观点',asset:'ETH',text:'交易所转出与稳定币流入同时出现。先查地址标签，再看现货成交是否跟上。',impact:'两条线索尚不足以确认买盘。地址归属和成交是下一步。'},
 {id:'p3',trader:'delta',time:'13:12',kind:'持仓变化',asset:'BTC',text:'事件前降低仓位，留出更多现金，等利率消息落地。',side:'空头',before:12,after:8,leverage:1,impact:'减少空头可能只是降低风险，不代表看涨。'},
 {id:'p4',trader:'north',time:'12:50',kind:'研究观点',asset:'ETH',text:'价格和成交量还没同步，不急着追。关注下一次回到观察区间的表现。',impact:'观点需要后续价格和成交量验证，暂不触发执行。'},
 {id:'p5',trader:'river',time:'12:18',kind:'持仓变化',asset:'SOL',text:'样例 SOL 观察仓从 4% 调整到 6%，继续控制单一资产占比。',side:'多头',before:4,after:6,leverage:1,impact:'增加仓位只是该样例账户的行为，不应直接复制其风险。'}];
export const EXCHANGES=['Binance','OKX','Bybit','Hyperliquid','Bitget','Gate'];
const exchangeWeights=[.34,.2,.17,.09,.075,.055];
export const EXCHANGE_SHARES=exchangeWeights.map(w=>w/exchangeWeights.reduce((sum,v)=>sum+v,0));
const fundingCenter=EXCHANGE_SHARES.reduce((sum,w,i)=>sum+w*i,0);
export const FUNDING=CRYPTO.map((a,i)=>({symbol:a.symbol,rates:EXCHANGES.map((_,j)=>fundingRate(a,j))}));
export const FUNDS=['IBIT','FBTC','GBTC','ARKB','BITB','BTCO','HODL','BRRR','EZBC','BTCW','BTC'];
export const ETF=Array.from({length:60},(_,i)=>{const flows=FUNDS.map((_,j)=>Math.round(((120/(j+1))*Math.sin(i*.52+j)+85/(j+1)-(j===2?42:0))*10)/10);return {date:new Date(Date.UTC(2026,7,26+i)).toISOString().slice(0,10),flows,total:Math.round(flows.reduce((s,v)=>s+v,0)*10)/10};});
export const FUND_META=FUNDS.map((symbol,i)=>({symbol,issuer:['BlackRock','Fidelity','Grayscale','ARK / 21Shares','Bitwise','Invesco / Galaxy','VanEck','CoinShares','Franklin','WisdomTree','Grayscale'][i],aum:[33120,14600,13500,3280,2570,490,1220,410,380,190,3820][i],fee:[.25,.25,1.5,.21,.2,.25,.2,.25,.19,.25,.15][i],price:46.8-i*1.61,volume:1280/(i+1),change:Math.cos(i)*1.4}));
export function exchangeSplit(total){let used=0;return EXCHANGE_SHARES.map((share,i)=>{const value=i===EXCHANGE_SHARES.length-1?total-used:total*share;used+=value;return value;});}
export function marketRows({category='全部',query='',favorites=[],sort='volume',direction='desc',minVolume=0,positiveOnly=false}={}){
 return MARKET.filter(a=>(category==='全部'||category===a.domain||category===a.sector||category==='自选'&&favorites.includes(a.symbol))&&`${a.symbol} ${a.name}`.toLowerCase().includes(query.toLowerCase())&&a.volume>=minVolume&&(!positiveOnly||a.change>0)).sort((a,b)=>{if(a[sort]==null)return b[sort]==null?0:1;if(b[sort]==null)return -1;return (a[sort]-b[sort])*(direction==='asc'?1:-1);});
}
export function fundingRate(asset,index,period='当前'){const base=asset.funding+(index-fundingCenter)*.0018*(CRYPTO.indexOf(asset)%4+1);const factor={'当前':1,'1日':3,'7日':21,'30日':90}[period]||1;return base*factor;}
export function selectMarket({category='全部',query='',favorites=[],sort='volume'}={}){return marketRows({category,query,favorites,sort});}
export function selectMetrics({category='全部指标',query='',favorites=[]}={}){return METRICS.filter(m=>(category==='全部指标'||category===m.category||category==='我的追踪'&&favorites.includes(m.id))&&`${m.name} ${m.asset} ${m.id}`.toLowerCase().includes(query.toLowerCase()));}

const moreNews=[
 ['10:52','资金','稳定币增发后仍停留在发行方地址，尚未进入市场','样例链上追踪记录了一次发行操作。资金目前仍在发行方地址，后续是否进入交易所需要继续跟踪。',['ETH'],true],
 ['10:26','市场','亚洲时段交易量上升，现货买卖价差收窄','样例交易所盘口显示深度改善，但仍需观察欧洲交易时段能否延续。',['BTC','ETH'],false],
 ['10:05','宏观','美债期限利差扩大，长端收益率变化更明显','样例情景中长端国债价格承压，研究组同时比较黄金与成长股的反应。',['US10Y','NDX','XAU'],true],
 ['09:48','链上','老币转移有所增加，暂未发现流入交易所','样例中的长币龄资金发生转移，接收地址尚无交易所标签。不能将这一变化直接视为获利卖出。',['BTC'],false],
 ['09:22','舆情','市场讨论从价格转向应用增长，独立来源增加','去除重复转发后，样例讨论中的应用相关内容占比上升，研究组等待实际使用数据交叉确认。',['SOL','ETH'],false],
 ['09:00','资金','链上借贷利率上升，稳定币需求出现变化','样例资金池借款需求上升，利用率提高。利率变化也可能由短期流动性转移造成。',['ETH'],false],
 ['08:42','市场','比特币现货成交活跃，合约持仓暂未同步增加','样例情景中现货量先于合约增长，研究组观察这一差异能否持续。',['BTC'],true],
 ['08:20','宏观','本周重要数据集中发布，关注事件前后的流动性','演示日历包含就业、通胀及央行会议窗口，可按事件查看相关资产。',['DXY','US10Y','SPX'],false],
 ['07:58','链上','验证者退出申请增加，链上供给仍需持续观察','样例退出队列增长，但退出不等于出售。研究组继续跟踪退出资金去向。',['ETH'],false],
 ['07:30','舆情','社媒出现分歧：交易员减仓，但讨论热度上升','样例账户的真实操作记录与观点分开展示，避免只看热门发言忽略仓位变化。',['BTC','SOL'],false],
 ['07:12','市场','黄金与美元短时同向，跨资产相关性回落','样例跨市场窗口出现非同步变化，历史相关性不能直接用于判断本轮方向。',['XAU','DXY'],false]
];
moreNews.forEach(([time,category,title,body,assets,important],i)=>NEWS.push({id:'n'+(i+8),time,category,title,body,assets,important,impact:'先比较消息前后的价格、成交与资金变化；出现反证时更新判断。',source:'HIVE 情景样本'}));
for(const [i,entry] of [['atlas','Atlas / 资金观察','A','#4e8ec2','资金研究'],['echo','Echo / 区间交易','E','#c27c8e','区间交易'],['orbit','Orbit / 波动研究','O','#a28c47','波动研究'],['pine','Pine / 现货观察','P','#549a81','现货交易'],['slope','Slope / 趋势笔记','S','#7e80c6','趋势跟踪']].entries()){
 const [id,name,initial,color,style]=entry;TRADERS.push({id,name,initial,color,style,bio:'本地演示账户，用于比较观点、持仓变化与历史表现。',assets:i%2?['BTC','SOL']:['ETH','BTC'],pnl:[12.6,-4.7,18.2,6.8,-8.4][i],drawdown:[7.8,12.5,16.2,4.8,19.2][i],days:90+i*15});
}
for(const [i,t] of TRADERS.entries()){
 t.equity=wave(10000*(1+t.pnl/100),630+i,90,.14);t.equity[0]=10000;t.platform=['Hyperliquid','链上','X'][i%3];t.winRate=[58,49,46,61,42,54,62,39][i];t.trades=24+i*9;
 if(i>2)POSTS.push({id:'p'+(i+3),trader:t.id,time:`${11-Math.floor(i/2)}:${i%2?'48':'26'}`,kind:i%2?'持仓变化':'研究观点',asset:t.assets[0],text:i%2?'将观察仓调整到目标范围，保留现金等待下一次信号。':'对照链上资金与价格结构，当前仍有分歧，继续观察下一轮变化。',...(i%2?{side:i%3?'多头':'空头',before:8+i,after:5+i,leverage:2}:{}),impact:'仓位变化与观点独立记录，只有在自己的风险条件通过后才考虑执行。'});
}

NEWS.forEach((n,i)=>{n.date=i<14?'2026-10-24':'2026-10-23';});

export const ETH_FUNDS=['ETHA','FETH','ETHE','ETH','ETHW','CETH','ETHV','QETH','EZET'];
export const ETH_FUND_META=ETH_FUNDS.map((symbol,i)=>({symbol,issuer:['BlackRock','Fidelity','Grayscale','Grayscale','Bitwise','21Shares','VanEck','Invesco / Galaxy','Franklin'][i],aum:[2850,1340,4480,1220,380,42,138,27,74][i],fee:[.25,.25,2.5,.15,.2,.21,.2,.25,.19][i],price:24.6+i*1.13,volume:190/(i+1),change:Math.cos(i+.5)*1.9}));
export const ETH_ETF=ETF.map((r,i)=>{const flows=ETH_FUNDS.map((_,j)=>Math.round((35/(j+1)*Math.sin(i*.36+j)+18/(j+1)-(j===2?16:0))*10)/10);return {date:r.date,flows,total:Math.round(flows.reduce((s,v)=>s+v,0)*10)/10};});

[...MARKET].sort((a,b)=>(b.marketCap||0)-(a.marketCap||0)).forEach((a,i)=>{a.rank=i+1;});

for(const t of TRADERS){let peak=t.equity[0],drawdown=0;for(const value of t.equity){peak=Math.max(peak,value);drawdown=Math.max(drawdown,(peak-value)/peak*100);}t.drawdown=Math.round(drawdown*10)/10;}

export {TOKEN_ICONS as COIN_ICONS} from './brand-icon-data.mjs';
