import decisions from './brain-evidence/decision-cases.json' with {type:'json'};
import reactions from './brain-evidence/market-reactions.json' with {type:'json'};

const categories={
  reserves:['稳定币储备','Stablecoin reserves'],governance:['协议治理','Protocol governance'],
  availability:['网络可用性','Network availability'],supply:['资产供应','Asset supply'],
  'market-structure':['市场结构','Market structure']
};
const label=(zh,en)=>[zh,en];
const section=(label,value)=>({label,value});
const caseKey=(id,phase)=>`decision/${id}/${phase}`;

function decisionRecords(c){
  const observationId=caseKey(c.id,'observation'),reviewId=caseKey(c.id,'review');
  const observed=c.facts.map(f=>({...c.sources[f.source],detail:f.text}));
  const reviewSources=(c.reviewSources||[c.sources.length-1]).map(i=>c.sources[i]);
  const topic=categories[c.category];
  const shared={nodes:[0,3,4,13],scopeKeys:c.assets,topic,eventAt:c.observedAt,precision:'day',availabilityBasis:'historical_reconstruction'};
  const comparisons=c.relatedIds.map(id=>({id:caseKey(id,'observation'),label:label('对照案例','Compare cases')}));
  const evidence=observed.map(s=>({label:Array.isArray(s.label)?s.label:[s.label,s.label],detail:s.detail,reference:s}));
  const title=(suffix,en)=>[c.title[0]+' · '+suffix,c.title[1]+' · '+en];
  return [
    {...shared,id:observationId,kind:'decision',knownAt:c.observedAt,title:title('当时的证据','Initial evidence'),
      body:observed[0].detail,source:observed[0].label,sourceUrl:observed[0].url,references:observed.slice(1),
      memorySections:[section(label('研究假设（回看）','Retrospective hypothesis'),c.hypothesis),
        section(label('另一种解释','Alternative explanation'),c.alternative),section(label('如何区分','What to check'),c.test)],
      memoryEvidence:evidence,relations:[{id:reviewId,label:label('后续验证','Follow-up')},...comparisons]},
    {...shared,id:reviewId,kind:'decision-review',knownAt:c.reviewedAt,observationEndAt:c.reviewedAt,
      title:title('后续验证','Follow-up'),body:c.outcome,source:reviewSources[0].label,sourceUrl:reviewSources[0].url,references:reviewSources.slice(1),
      memorySections:[section(label('适用边界','When it applies'),c.lesson)],
      relations:[{id:observationId,label:label('回看当时','Initial evidence')},...comparisons]}
  ];
}

const decimal=new Intl.NumberFormat('en-US',{maximumSignificantDigits:7});
const pct=n=>(n>0?'+':'')+n.toFixed(2)+'%';
function reactionRecord(r){
  const pattern=reactions.method.patterns[r.kind];
  const close=decimal.format(r.close)+' '+r.priceUnit;
  const move=pct(r.dayReturnPct), end=r.horizons.at(-1),outcome=pct(end.returnPct);
  const readout=r.kind==='price-shock'?label('当日阈值 '+r.thresholdPct.toFixed(2)+'%。','The threshold that day was '+r.thresholdPct.toFixed(2)+'%.')
    :r.kind==='volume-divergence'?label('当日成交量为基准的 '+r.volumeMultiple.toFixed(2)+' 倍。','Event volume was '+r.volumeMultiple.toFixed(2)+'× the baseline.')
    :label('当日振幅为昨收的 '+r.rangePct.toFixed(2)+'%，下影占振幅的 '+r.lowerWickPct.toFixed(2)+'%。','The range was '+r.rangePct.toFixed(2)+'% of the previous close; the lower wick was '+r.lowerWickPct.toFixed(2)+'% of the range.');
  const reference={label:r.venue,url:r.sourceUrl};
  return {
    id:r.id,kind:'reaction',topic:pattern.label,scopeKeys:r.scopeKeys,nodes:[0,2,3,4,13],
    eventAt:r.eventAt,eventDay:r.day,observationEndAt:r.reviewedAt,knownAt:r.knownAt,
    source:r.venue,sourceUrl:r.sourceUrl,title:[r.symbol+' · '+pattern.label[0],r.symbol+' · '+pattern.label[1]],
    body:[r.market+' 当日收于 '+close+'（'+move+'）。30 天后，收盘价相对当日变动 '+outcome+'。',
      r.market+' closed at '+close+' ('+move+'). Its close 30 days later was '+outcome+' from that level.'],
    memorySections:[
      section(label('入选依据','Why this day qualified'),pattern.criterion.map((value,i)=>value+' '+readout[i])),
      section(label('比较口径','Comparison basis'),reactions.method.followUp)
    ],
    memoryEvidence:r.horizons.map(h=>{
      const price=decimal.format(h.close)+' '+r.priceUnit,change=pct(h.returnPct),drawdown=pct(h.maxDrawdownPct);
      return {label:label('第 '+h.days+' 天 · '+change,'Day '+h.days+' · '+change),
        detail:label('收盘 '+price+'，期间最大收盘回撤 '+drawdown+'。','Close '+price+'. Maximum close-to-close drawdown in this window: '+drawdown+'.'),reference};
    }),
    relations:r.relations.map(link=>({id:link.id,label:link.kind==='parallel'?label('30 日同向','Same 30-day direction'):label('30 日结果不同','Different 30-day result')}))
  };
}

export const reasoningRecords=[...decisions.cases.flatMap(decisionRecords),...reactions.records.map(reactionRecord)];
