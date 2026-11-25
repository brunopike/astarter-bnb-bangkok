/*! Advanced Stats · UI LAYOUT · MIT · see LICENSE and SOURCE.md. */
import {useRef} from 'react';
import {ClippedAreaChart} from './charts.jsx';
import {TimelineAnimation} from './timeline-animation.jsx';

// The requested source component fits a repeated feed as a quote, chart and flat KPI row.
export function AdvancedStats({data,reducedMotion=false}) {
  const timelineRef=useRef(null),hasHistory=data.history.length>1;
  return <section ref={timelineRef} className={`sig-stats${hasHistory?'':' sig-stats-sparse'}`} aria-label={data.labels.summary}>
    <div className="sig-stats-grid">
      <TimelineAnimation animationNum={1} timelineRef={timelineRef} reduceMotion={reducedMotion} className="sig-stats-quote">
        <span>{data.labels.price}</span>
        <strong className={data.price===null?'sig-stats-missing':'dot-number'}>{data.price===null?data.labels.unavailable:data.priceText}{data.price!==null&&<small title={data.unitDescription}>{data.unit}</small>}</strong>
        {hasHistory?<span className={`sig-stats-change ${data.change>0?'is-positive':data.change<0?'is-negative':''}`} title={data.labels.priceChange}><b>{data.changeText}</b><small>{data.labels.change}</small></span>:!data.validityInState&&data.validity!==data.labels.unavailable&&<span className="sig-stats-validity">{data.labels.validity} · {data.validity}</span>}
      </TimelineAnimation>
      {hasHistory&&<TimelineAnimation animationNum={2} timelineRef={timelineRef} reduceMotion={reducedMotion} className="sig-stats-chart-panel"><ClippedAreaChart data={data.history} labels={data.labels} unit={data.unit} reduceMotion={reducedMotion}/></TimelineAnimation>}
    </div>
    <div className="sig-stats-kpis">
      {data.kpis.map((kpi,index)=><TimelineAnimation animationNum={3+index} timelineRef={timelineRef} reduceMotion={reducedMotion} key={kpi.label} className="sig-stats-kpi">
        <span>{kpi.label}</span><strong>{kpi.value}</strong>{kpi.unit&&<small>{kpi.unit}</small>}
      </TimelineAnimation>)}
    </div>
  </section>;
}
