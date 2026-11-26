const escape = value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export {escape as escapeHTML};

export function renderReceipt(record,en=true) {
  const {asset,decision,attribution}=record;
  const t=(english,chinese)=>en?english:chinese;
  const money=value=>new Intl.NumberFormat(en?'en-US':'zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value)+' '+asset.quote;
  const rows=[
    [t('Evidence cutoff','数据截止'),decision.asOf],
    [t('Selected strategy','策略'),decision.selected],
    [t('Risk budget','风险预算'),money(decision.risk.riskBudget)],
    [t('Execution','执行结果'),decision.execution.reason],
    [t('Trading fees','手续费'),money(attribution.entryFee+attribution.exitFee)],
    [t('Net paper P&L','模拟净盈亏'),money(attribution.netPnl)]
  ];
  return '<section><h2>'+escape(asset.market)+' · '+escape(decision.barOpenAt.slice(0,10))+'</h2><dl class="bp-facts">'+
    rows.map(([label,value])=>'<div><dt>'+escape(label)+'</dt><dd>'+escape(value)+'</dd></div>').join('')+'</dl></section>';
}
