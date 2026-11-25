/*! ClippedAreaChart · UI LAYOUT · MIT · see LICENSE and SOURCE.md. */
import {Area,AreaChart,CartesianGrid,ResponsiveContainer,XAxis,YAxis} from 'recharts';
import {useId,useRef,useState} from 'react';
import {useSpring,useMotionValueEvent,useReducedMotion} from 'motion/react';

export function ClippedAreaChart({data,labels,unit,reduceMotion=false}) {
  const chartRef=useRef(null),gradientId=useId().replace(/:/g,''),[index,setIndex]=useState(data.length-1),[axis,setAxis]=useState(null),[width,setWidth]=useState(0),systemReduced=useReducedMotion(),reduced=reduceMotion||systemReduced;
  const springX=useSpring(0,{damping:30,stiffness:100});
  useMotionValueEvent(springX,'change',setAxis);
  const coordinate=width?Math.min(width-8,Math.max(8,axis??width-8)):null;
  const select=i=>{const next=Math.min(data.length-1,Math.max(0,i));setIndex(next);const x=8+(width-16)*next/(data.length-1);reduced?springX.jump(x):springX.set(x);};
  const leave=()=>select(data.length-1);
  return <div className="sig-clipped-chart" data-signal-chart onClick={event=>event.stopPropagation()}>
    <header><h3>{labels.path}</h3><div className="sig-stats-readout" title={labels.price}><strong>{data[index].priceText}</strong>{' '}<small>{unit} · {data[index].time}</small></div></header>
    <div ref={chartRef} className="sig-stats-chart" tabIndex={0} role="group" aria-label={`${labels.path} · ${labels.price} · ${labels.keyboard}`} onKeyDown={event=>{let next;if(event.key==='ArrowLeft')next=index-1;else if(event.key==='ArrowRight')next=index+1;else if(event.key==='Home')next=0;else if(event.key==='End')next=data.length-1;else return;event.preventDefault();event.stopPropagation();select(next);}}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} onResize={w=>{setWidth(w);springX.jump(8+(w-16)*index/(data.length-1));}}>
        <AreaChart data={data} accessibilityLayer={false} margin={{top:4,right:8,bottom:0,left:8}} onMouseMove={state=>{const i=Number(state.activeTooltipIndex);if(state.activeTooltipIndex!==undefined&&state.activeTooltipIndex!==null&&Number.isInteger(i)&&i>=0&&i<data.length)select(i);}} onMouseLeave={leave}>
          <CartesianGrid vertical={false} stroke="var(--b-line)" strokeDasharray="3 3" horizontalCoordinatesGenerator={({height})=>[4,height-18]}/>
          <XAxis dataKey="time" tickLine={false} axisLine={false} height={18} tickMargin={4} ticks={[data[0].time,data.at(-1).time]} interval={0} tick={({x,y,payload})=><text x={x} y={y+8} textAnchor={payload.value===data[0].time?'start':'end'} fill="var(--b-muted)" fontSize={11}>{payload.value}</text>}/>
          <YAxis hide domain={['dataMin','dataMax']} padding={{top:4,bottom:4}}/>
          <Area dataKey="price" type="monotone" fill={`url(#${gradientId})`} fillOpacity={.7} stroke="var(--chart-accent)" strokeWidth={2} clipPath={coordinate===null?undefined:`inset(0 ${Math.max(0,width-coordinate)}px 0 0)`} isAnimationActive={false}/>
          {coordinate!==null&&<line x1={coordinate} y1={4} x2={coordinate} y2="76%" stroke="var(--chart-accent)" strokeDasharray="3 3" strokeOpacity={.45}/>}
          <Area dataKey="price" type="monotone" fill="none" stroke="var(--chart-accent)" strokeOpacity={.15} strokeWidth={2} isAnimationActive={false}/>
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--chart-accent)" stopOpacity={.38}/><stop offset="95%" stopColor="var(--chart-accent)" stopOpacity={0}/></linearGradient></defs>
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <span className="sig-chart-announcement" aria-live="polite">{labels.price} · {data[index].time} · {data[index].priceText} {unit}</span>
  </div>;
}
