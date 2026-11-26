const escape = value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const project='https://github.com/brunopike/astarter-bnb-bangkok/tree/main/src/deep-brain';
export function renderPaperCase(record,en=true) {
  const t=(zh,english)=>en?english:zh;
  const n=(x,digits=4)=>new Intl.NumberFormat(en?'en-US':'zh-CN',{maximumFractionDigits:digits}).format(x);
  const d=record.decision,r=d.execution,a=record.attribution,v=record.verification;
  const fee=a.entryFee+a.exitFee,unit=escape(record.asset.quote);
  const value=x=>escape(n(x))+' '+unit;
  const fact=(name,content)=>'<div><dt>'+name+'</dt><dd>'+content+'</dd></div>';
  const column=(name,heading,rows)=>'<section class="bp-stage"><h4>'+name+'</h4><strong>'+heading+'</strong><dl class="bp-facts">'+rows+'</dl></section>';
  const winner=d.candidates.find(c=>c.id===d.selected);
  return '<div class="bp-run"><div><strong>'+escape(record.asset.market)+'</strong><span>'+escape(d.barOpenAt.slice(0,10))+' UTC</span></div><span>'+t('历史模拟成交','Historical paper fill')+'</span></div>'+
    '<div class="bp-trace">'+
    column('Brain',t('已收盘日线','Closed market data'),
      fact(t('数据截止','Evidence cutoff'),escape(d.asOf.slice(0,10))+' UTC')+
      fact(t('决策窗口','Decision window'),n(d.barCount)+' '+t('根日线','bars'))+
      fact(t('交易所复核','Venue recheck'),n(v.matchedBars)+' / '+n(v.matchedBars)))+
    column('Thinking',t('回调买入','Buy the pullback'),
      fact(t('校准信号','Calibration signals'),n(winner.sampleCount)+' / '+n(d.candidates.find(c=>c.id==='cash').sampleCount))+
      fact(t('得分高于现金','Score above cash'),'+'+n(winner.score,5)+' pp')+
      fact(t('风险预算','Risk budget'),value(d.risk.riskBudget)))+
    column('Execution',t('止损退出','Stopped out'),
      fact(t('模拟仓位','Paper notional'),value(r.amount))+
      fact(t('止损触发价','Stop trigger'),n(r.stopPrice,2))+
      fact(t('模拟退出价','Modeled exit'),n(r.exitPrice,2)))+'</div>'+
    '<dl class="bp-metrics">'+fact(t('参考价格变动','Price movement'),value(a.referenceMove))+
      fact(t('滑点','Slippage'),value(-a.slippage))+fact(t('双边费用','Trading fees'),value(-fee))+
      fact(t('净盈亏','Net P&L'),value(r.netPnl))+'</dl>'+
    '<details class="bp-method"><summary>'+t('记忆回写与模型解读','Memory and model review')+'</summary><div class="bp-window">'+
    '<p>'+t('Living Brain 已回读并核对原文。','Living Brain returned the saved record with a matching checksum.')+
    ' '+escape(v.explanation.model)+' · '+escape(v.memory.compiledAt.slice(0,10))+' UTC</p>'+
    '<p>'+escape(en?v.explanation.englishSummary:'回调规则满足入选条件。开盘跳空低于风控上限，模拟盘建仓后，当日最低价跌破止损。价格变动亏损 23.0810 USDT，另付滑点 0.6042 和手续费 1.2084，净亏 24.8936 USDT。')+'</p>'+
    '<details><summary>'+t('模型回答原文（中文）','Original model response (Chinese)')+'</summary>'+
    v.explanation.answer.split(/\n\n/).map(p=>'<p>'+escape(p.replaceAll('**','').replaceAll('`',''))+'</p>').join('')+'</details></div></details>'+
    '<div class="bp-sources bp-window"><a href="'+escape(v.proofUrl)+'" target="_blank" rel="noopener">'+t('成交凭证','Execution receipt')+'</a> '+
    '<a href="'+project+'" target="_blank" rel="noopener">'+t('运行开源代码','Run the open-source code')+'</a></div>';
}
