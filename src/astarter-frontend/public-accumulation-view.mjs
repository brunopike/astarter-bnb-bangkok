import {pair} from './locale.mjs';

// Algoros permits its own hosted chart with its backlink. No series is mirrored or passed to research.
export function publicAccumulationView(L=pair){
 const title=L('积累地址持有量 · BTC','Supply on accumulation addresses · BTC');
 const scope=L('Algoros 按 UTC 日统计持有至少 10 BTC、从未支出且从未收到挖矿奖励输出的地址余额合计。','Algoros totals the daily balances of addresses holding at least 10 BTC that have never spent funds or received a coinbase output.');
 const link=L('在 Algoros 查看图表与计算方法','Chart and methodology on Algoros');
 return `<div class="dc-accumulation-reference"><p class="dc-live-note">${scope}</p><iframe src="https://algoros.ai/embed/accumulation-addresses/" width="100%" height="480" loading="lazy" style="display:block;border:0" referrerpolicy="strict-origin-when-cross-origin" title="${title} · algoros.ai"></iframe><a href="https://algoros.ai/metrics/accumulation-addresses/" target="_blank" rel="noopener noreferrer">${link} ↗</a></div>`;
}
