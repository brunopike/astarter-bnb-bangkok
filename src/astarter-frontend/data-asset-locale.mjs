// Complete text-node / accessible-label translations for data-asset-view and
// its shared helpers. Apply exact entries BEFORE fragment replacement.
// Do not add short OHLC keys to a substring dictionary: 开 / 高 / 低 / 收 / 量
// are intentionally exact-only labels.
export const assetEnglishCopy={
 '市场行情':'Markets','模拟数据':'Simulated data','模拟':'Simulation',
 '总览':'Overview','合约数据':'Derivatives','现货数据':'Spot',
 '合约成交额 · 24h':'Futures volume · 24h','现货成交额 · 24h':'Spot volume · 24h',
 '市值':'Market cap','合约持仓':'Open interest','24h 变化':'24h change','7d 变化':'7d change',
 '收益率走势':'Yield chart','价格走势':'Price chart','价格表现':'Price performance',
 '4小时':'4h','24小时':'24h','7天':'7d','30天':'30d','90天':'90d','180天':'180d',
 '年初至今':'YTD','1年':'1y','全部样本':'Full sample',
 '短周期取自同一行情样本；30天及更长区间为扩展模拟序列。全部样本为一年，不代表上市以来表现。':'Short periods use the same price fixture. Periods of 30 days or more use an extended simulated series. The full sample covers one year, not performance since listing.',
 '多空持仓':'Long / short positions','多头':'Long','空头':'Short','多 / 空':'Long / short',
 '交易所对比 ↗':'Compare exchanges ↗',
 '模拟名义持仓比例，与账户人数比不是同一种统计。多头与空头合计为100%。':'Simulated shares of position notional, not account counts. Long and short shares add up to 100%.',
 '分时清算':'Liquidations by period',
 '窗口均截止快照时间；1h、4h、12h是24h内的累计子窗口，不能相加。多头加空头等于该窗口总额。':'All windows end at the snapshot time. The 1h, 4h and 12h windows are included in the 24h total; do not add them together. Long and short liquidations sum to each window’s total.',
 '交易所':'Exchange','交易对':'Pair','价格':'Price','24h 涨跌':'24h change','24h 成交额':'24h volume',
 '份额':'Share','价差':'Spread','持仓':'Open interest','费率 / 8h':'Funding / 8h',
 '多头清算':'Long liquidations','空头清算':'Short liquidations','合约':'Futures','现货':'Spot',
 '现货主动买卖':'Spot taker buy / sell','时间窗口':'Time window','主动买入':'Taker buys','主动卖出':'Taker sells',
 '买入 − 卖出':'Buys − sells','买入占比':'Buy share',
 '按模拟主动成交方向归类，买入加卖出等于该窗口现货成交额；不是链上资金流入流出。':'Grouped by simulated taker side. Buys plus sells equal spot volume for the window. These are trades, not on-chain inflows or outflows.',
 '资金费率':'Funding rate','持仓量':'Open interest','成交额':'Volume','清算':'Liquidations','持仓加权费率':'OI-weighted funding',
 '百万 USD':'USD million','现货盘口':'Spot order book','价格 · USD':'Price · USD','累计':'Cumulative size',
 '价差 2.6 bps':'Spread 2.6 bps','相关消息':'Related news',
 '这个样例资产暂无关联消息。':'No related news in this asset’s sample.',
 'AI 帮我看':'Ask AI','价格上涨，资金跟上了吗？':'Price is rising. Is capital following?',
 '价格回落，先看哪里出现变化':'Price is falling. What changed?',
 '查看成交是否跟上价格，同时比较持仓与交易成本。':'Compare price with trading volume, open interest and funding costs.',
 '对照美元、利率和重要事件，继续观察跨市场反应。':'Compare the dollar, yields and major events to understand the wider market response.',
 '这里是预设观察提示。点击后进入平台的模拟研究流程，不代表模型已经完成分析。':'This is a preset observation. The button starts the platform’s simulated research flow; no model analysis has been completed.',
 '跨市场观察':'Cross-market watch','合约概览':'Derivatives overview','24h 合约成交额':'24h futures volume',
 '加权费率 / 8h':'Weighted funding / 8h','成交额 / 持仓':'Volume / open interest',
 '持仓、成交与清算均与市场总览的同资产快照一致。费率统一换算为8小时口径。':'Open interest, volume and liquidations match the asset’s market snapshot. Funding rates are normalized to an eight-hour period.',
 '交易所持仓':'Open interest by exchange','成交额 / 市值':'Volume / market cap','交易所覆盖':'Exchanges covered',
 '5 家':'5 exchanges','样本报价':'Sample quote','现货成交额':'Spot volume','24h 现货成交额':'24h spot volume','30 天':'30 days',
 '行情观察':'Market review',

 // Shared stamp / research / table / chart helpers.
 '样本快照':'Sample snapshot','查看指标说明':'About this metric',
 '所有行情、新闻、交易员与分析均为本地模拟样本。页面不会获取实时数据、调用 AI 或提交交易。':'All prices, news, traders and analysis are local fixtures. This page does not fetch live data, call AI models or submit trades.',
 '交给 AI 研究 ↗':'Research with AI ↗','已加入观察':'Watching','加入观察列表':'Add to watchlist',
 '数据表，可横向滚动':'Data table; scroll horizontally',
 '没有匹配的结果，试试其他筛选。':'No matching results. Try different filters.',
 '向前查看':'Previous window','向后查看':'Next window','缩小图表':'Zoom out','放大图表':'Zoom in',
 '显示全部数据':'Show all data','适配':'Fit','起点':'Start','终点':'End','拖动查看':'Drag to explore',
 '当前范围暂无记录':'No records in this range','暂无数据':'No data',
 '开':'Open','高':'High','低':'Low','收':'Close','量':'Volume',
 '标普 500':'S&P 500','纳斯达克 100':'Nasdaq 100','黄金现货':'Spot gold','美元指数':'US dollar index','美国十年国债':'US 10-year Treasury',
 '点':'pts','USD/盎司':'USD/oz',

 // The four related headlines currently shown for each supported asset.
 '利率决议窗口临近，关注美元与风险资产的同步变化':'Rate decision approaches: watch the dollar and risk assets',
 '现货 ETF 样本出现连续净流入':'Spot ETF sample shows consecutive net inflows',
 '合约持仓上升，资金费率开始分化':'Open interest rises as funding rates diverge',
 '成交量回升，价格仍在观察区间内':'Volume recovers while price stays within the observed range',
 '一组地址出现大额转账，接收方身份尚不明确':'Large transfers detected; recipients remain unidentified',
 '稳定币增发后仍停留在发行方地址，尚未进入市场':'New stablecoins remain with the issuer, outside the market',
 '亚洲时段交易量上升，现货买卖价差收窄':'Asian-session volume rises as spot spreads narrow',
 '同一条消息被多次转发，去重后讨论热度回落':'Discussion activity falls after duplicate posts are removed',
 '市场讨论从价格转向应用增长，独立来源增加':'Discussion shifts from price to adoption, with more independent sources',
 '社媒出现分歧：交易员减仓，但讨论热度上升':'Social signals diverge: traders cut positions as discussion grows',
 '美元走弱，黄金与股指反应并不一致':'The dollar weakens; gold and equities respond differently',
 '本周重要数据集中发布，关注事件前后的流动性':'Busy data week ahead: watch liquidity around releases',
 '美债期限利差扩大，长端收益率变化更明显':'The Treasury curve steepens as long-term yields move more',
 '黄金与美元短时同向，跨资产相关性回落':'Gold and the dollar move together briefly as correlations weaken'
};

const label=text=>assetEnglishCopy[text]||text;
// Same [RegExp, replacement callback] format as locale.mjs dynamic patterns.
// Run before substring replacement. Never translate data-value, href or IDs.
export const assetLocalePatterns=[
 [/^([A-Z0-9]+) 数据$/,(_,symbol)=>`${symbol} data`],
 [/^([A-Z0-9]+) 交易市场$/,(_,symbol)=>`${symbol} markets`],
 [/^([A-Z0-9]+) · (资金费率|持仓量|成交额|清算)$/,(_,symbol,metric)=>`${symbol} · ${label(metric)}`],
 [/^([A-Z0-9]+) (合约数据|现货数据|行情观察)$/,(_,symbol,kind)=>`${symbol} ${label(kind).toLowerCase()}`],
 [/^(1|4|12|24)h 清算$/,(_,hours)=>`${hours}h liquidations`],
 [/^数量 · ([A-Z0-9]+)$/,(_,symbol)=>`Size · ${symbol}`],
 [/^([+−-]?[\d.,]+)% · 较前一日$/,(_,value)=>`${value}% · vs. prior day`],
 [/^(取消收藏|收藏) (.+)$/,(_,action,symbol)=>`${action==='收藏'?'Add':'Remove'} ${symbol} ${action==='收藏'?'to':'from'} watchlist`],
 [/^(样本快照|Snapshot) · (.+)$/,(_,prefix,date)=>`Sample snapshot · ${date}`],
 [/^(\d+)–(\d+) \/ (\d+) (根 K 线|个记录)$/,(_,start,end,total,kind)=>`${start}–${end} / ${total} ${kind==='根 K 线'?'candles':'records'}`],
 [/^(?:价格|指标)走势，(\d+)个数据点，起点(.+)，终点(.+)$/,(_,count,start,end)=>`Trend: ${count} points, ${start} to ${end}`],
 [/^(.+) K线与成交量，(\d+)根，最新收盘(.+)，坐标时间UTC$/,(_,period,count,close)=>`${period} candles and volume; ${count} candles; last close ${close}; time axis in UTC`],
 [/^(.+)，左右方向键查看数据$/,(_,title)=>`${label(title)}: use the left and right arrow keys to inspect data`],
 [/^(.+)窗口起点$/,(_,title)=>`${label(title)} window start`],
 [/^(.+)窗口终点$/,(_,title)=>`${label(title)} window end`],
 [/^平移(.+)时间窗口$/,(_,title)=>`Pan ${label(title)} time window`]
];

// Optional single-call adapter for integration before legacy translation.
export function translateAssetText(text){
 if(typeof text!=='string')return null;
 const key=text.trim();
 if(Object.hasOwn(assetEnglishCopy,key))return text.replace(key,assetEnglishCopy[key]);
 for(const [pattern,render] of assetLocalePatterns)if(pattern.test(key))return text.replace(key,key.replace(pattern,render));
 return null;
}
