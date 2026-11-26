const groups = {
  snapshot:['#b19afa','快照','Snapshot'],chain:['#68d9f8','链上','On-chain'],
  market:['#70d99c','市场','Market'],strategy:['#f3c46a','策略','Strategy'],review:['#ed91a3','复盘','Review']
};
// Display-space colors of the Cortexa scan. Keep the workspace's role colors independent.
export const cortexaTones={
  snapshot:['#b4a8de','#756399'], chain:['#91cfe3','#42798c'],
  market:['#94aedb','#506e9c'], strategy:['#d3bca9','#866b58'],
  review:['#b8a5d2','#7b648e'], gain:['#90c9cb','#427c80'], loss:['#cda3c1','#8e607f']
};
const entries = [
  ['snapshot',1,'以太坊合并','Ethereum Merge','同一份 ETH 市场快照关联主网区块与 Coinbase 分钟线。链上与市场 Agent 从这里分别核查。','The same ETH snapshot links a mainnet block and Coinbase candles for independent checks.'],
  ['chain',2,'链上判断','Chain finding','首个权益证明执行区块确认了合并时间。资金流向仍待核实。','The first proof-of-stake execution block confirms the transition time. Flow direction remains open.'],
  ['market',2,'市场反应','Market response','Coinbase 的两根分钟线显示 ETH 上涨。跨场所成交与盘口深度仍待补充。','Two Coinbase candles show a rise in ETH. Cross-venue volume and depth are still missing.'],
  ['strategy',2,'观察策略 v1','Watch strategy v1','智选信号展示观察条件。在独立场所与可成交深度获得验证后，重新评估。','Signals displays the watch conditions. Reassess once another venue and executable depth are verified.'],
  ['review',2,'到期复盘','Expiry review','五分钟窗口结束后，一起记录行情变化、用户回执和 AI 交易订单状态，供下一次调用。','At expiry, the case stores the market move, user receipt status and LensWave order status for later use.'],
  ['chain',3,'首个 PoS 区块','First PoS block','主网区块 15,537,394 于 06:42:59 UTC 产生，包含 80 笔交易。','Mainnet block 15,537,394 was produced at 06:42:59 UTC and contains 80 transactions.'],
  ['market',3,'分钟收盘价','Minute closes','Coinbase ETH-USD 两根相邻分钟线的收盘价从 $1,589.44 升至 $1,616.76。','Consecutive Coinbase ETH-USD closes rose from $1,589.44 to $1,616.76.'],
  ['snapshot',3,'快照时点','Snapshot cutoff','快照锁定在 06:44 UTC。到期行情单独保存在复盘记录里。','The snapshot cutoff is 06:44 UTC. Later prices are stored separately in the review.'],
  ['market',3,'盘口深度','Market depth','快照缺少可执行的盘口深度，无法据此估算下单滑点。','The snapshot lacks executable depth, so slippage cannot be estimated from this case.'],
  ['strategy',3,'升级条件','Upgrade conditions','补齐独立交易场所的成交证据，同时核实可执行深度，再决定是否升级信号。','Check independent venue trades and executable depth before upgrading the signal.'],
  ['strategy',3,'观察窗口','Watch window','观察窗口为 06:44–06:49 UTC。到期后按同一策略版本归档结果。','The watch window runs from 06:44 to 06:49 UTC. Results are filed under the same strategy version.'],
  ['review',3,'自主成交回执','User fill receipt','智选信号已展示策略。本案未取得用户的成交回执，成交状态记为未知。','The strategy was shown in Signals. No user receipt is available, so fill status is unknown.'],
  ['review',3,'AI 交易订单','LensWave orders','本案未提供 AI 交易授权，订单数为零。','This case has no LensWave trading mandate and no orders.'],
  ['review',3,'五分钟行情','Five-minute move','到期时 Coinbase ETH-USD 收于 $1,628.61，较快照参考价上涨 0.73%。','Coinbase ETH-USD closed at $1,628.61 at expiry, up 0.73% from the snapshot.']
];
const notes = entries.map(([group,level,title,enTitle,body,enBody])=>({
  group,level,kind:group,color:groups[group][0],title:[title,enTitle],body:[body,enBody]
}));
const directions=Object.entries(groups).map(([key,[color,zh,en]])=>({key,color,title:[zh,en]}));
const detailEdges=[[1,5],[2,6],[0,7],[2,8],[3,9],[3,10],[4,11],[4,12],[4,13],[8,9]];
export {notes,directions,detailEdges};
