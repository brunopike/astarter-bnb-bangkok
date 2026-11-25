import {L} from './execution-views.mjs';

// Mechanism diagrams, never live prices, returns or backtest results.
// Landing photonic layers: spectral envelope, fine light core and a bounded moving packet.
// Source adaptations: Roman Vasnev / 21st Analytics Bento 40334 (pointer
// inspection) and Web3 Bento 40327 (area layers, restrained chart hierarchy).
const tag=(name,attrs,content='')=>'<'+name+' '+attrs+'>'+content+'</'+name+'>';
const path=(d,cls='sa-path',extra='')=>{
 const main=tag('path','class="'+cls+'" d="'+d+'" '+extra);
 if(!['sa-path','sa-secondary'].includes(cls))return main;
 return tag('path','class="sa-light-envelope '+(cls==='sa-secondary'?'sa-light-alt':'')+'" d="'+d+'" aria-hidden="true"')+main+tag('path','class="sa-light-core" d="'+d+'" aria-hidden="true"');
};
const rect=(x,y,w,h,cls='sa-band',extra='')=>tag('rect','x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" class="'+cls+'" '+extra);
const line=(x1,y1,x2,y2,cls='sa-grid')=>tag('line','x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" class="'+cls+'"');
const text=(x,y,value,cls='sa-label',anchor='start')=>tag('text','x="'+x+'" y="'+y+'" class="'+cls+'" text-anchor="'+anchor+'"',value);
const dot=(x,y,extra='')=>tag('circle','cx="'+x+'" cy="'+y+'" r="3.2" class="sa-price-point" '+extra);
const poly=ps=>'M'+ps.map(p=>p.join(' ')).join('L');
const points=(ys,x=28,span=344)=>ys.map((y,i)=>[x+i*span/(ys.length-1),y]);
// Shape-preserving cubic interpolation: smooth peaks without invented overshoots.
const curve=ps=>{
 const slopes=ps.slice(1).map((p,i)=>(p[1]-ps[i][1])/(p[0]-ps[i][0]));
 const tangents=ps.map((_,i)=>{
  if(!i)return slopes[0];if(i===ps.length-1)return slopes.at(-1);
  const a=slopes[i-1],b=slopes[i];
  return a*b<=0?0:2*a*b/(a+b);
 });
 return ps.map((p,i)=>{
  if(!i)return 'M'+p.join(' ');
  const a=ps[i-1],dx=(p[0]-a[0])/3;
  return 'C'+[a[0]+dx,a[1]+tangents[i-1]*dx,p[0]-dx,p[1]-tangents[i]*dx,...p].join(' ');
 }).join(' ');
};
// Inventory reductions remain discrete steps, with softened corners.
const roundedSteps=(ps,r=6)=>ps.map((p,i)=>{
 if(!i)return 'M'+p.join(' ');
 if(i===ps.length-1)return 'L'+p.join(' ');
 const a=ps[i-1],b=ps[i+1],d1=Math.hypot(p[0]-a[0],p[1]-a[1]),d2=Math.hypot(b[0]-p[0],b[1]-p[1]),radius=Math.min(r,d1/2,d2/2);
 return 'L'+[p[0]-(p[0]-a[0])*radius/d1,p[1]-(p[1]-a[1])*radius/d1].join(' ')+'Q'+p.join(' ')+' '+[p[0]+(b[0]-p[0])*radius/d2,p[1]+(b[1]-p[1])*radius/d2].join(' ');
}).join(' ');
const focus=(at,content)=>tag('g','class="sa-focus" data-focus="'+at+'"',content);
const tip=(label,value)=>[L(...label),L(...value)];
const area=(ps,uid,base=161)=>path(curve(ps)+'L'+ps.at(-1)[0]+' '+base+'H'+ps[0][0]+'Z','sa-area','fill="url(#'+uid+')"');
let serial=0;

function candles(ys,{x=34,span=326}={}){
 return ys.map((close,i)=>{
  const open=i?ys[i-1]+(i%3===0?-4:3):close+11,high=Math.min(open,close)-6-(i%3)*2,low=Math.max(open,close)+6;
  const px=x+i*span/(ys.length-1),cls=close<open?'sa-candle-up':'sa-candle-down';
  return focus(i/(ys.length-1),line(px,high,px,low,cls)+rect(px-4,Math.min(open,close),8,Math.max(3,Math.abs(open-close)),cls,'rx="1"'));
 }).join('');
}
function bars(values,{x=30,span=340,base=158,width=13,cls='sa-bar',signed=false}={}){
 return values.map((v,i)=>{
  const px=x+i*span/(values.length-1),h=Math.abs(v),top=signed&&v<0?base:base-h;
  return focus(i/(values.length-1),rect(px-width/2,top,width,h,signed&&v<0?'sa-bar-muted':cls,'rx="3" style="--sa-bar-color:var(--s'+(1+Math.floor(i*6/Math.max(1,values.length-1)))+')"'));
 }).join('');
}
function build(id,uid){
 let marks='',scan='',tips=[],caption='',outcome='',type='price',horizontal=false;
 const set=(z,en,oz,oe)=>{caption=L(z,en);outcome=L(oz,oe);};
 const base=()=>[61,105,155].map(y=>line(28,y,372,y)).join('');
 const priceTips=[tip(['观察价格','Watch price'],['等待条件','Wait for setup']),tip(['信号出现','Signal found'],['继续确认','Confirm first']),tip(['条件满足后','Once confirmed'],['按计划行动','Follow the plan'])];
 marks=base();
 if(id==='S03'){
  type='candles';set('K 线 · 均线 · 动量','Candles · MA · momentum','趋势与动量共同确认','Trend + momentum');
  const ys=[137,131,136,118,109,114,96,101,87,91,75,67,72,60];
  marks+=candles(ys)+path(curve(points([145,142,137,130,119,112,105,96,89,81,75,68,64,59],34,326)),'sa-secondary');
  marks+=line(28,174,372,174,'sa-rule')+text(30,190,'RSI 50','sa-small')+path(curve(points([184,187,181,186,180,176,178,170,172,166,168,162],93,267)));
  scan=poly(points(ys,34,326));tips=priceTips;
 }else if(id==='S00'){
  type='multi-timeframe';set('三个周期，逐层确认','Three timeframes, aligned','方向一致后再入场','Enter on alignment');
  marks='';
  const rows=[[78,73,76,66,68,57,54],[120,124,113,116,103,99,94],[166,159,166,150,155,139,134]];
  rows.forEach((ys,i)=>{marks+=focus(i/2,text(28,[74,117,161][i],['4h','1h','15m'][i],'sa-small')+line(66,[83,129,173][i],368,[83,129,173][i])+path(curve(points(ys,70,280)),'sa-secondary')+dot(350,ys.at(-1))+path('M358 '+(ys.at(-1)+1)+'l3 3 6 -7','sa-tick'));});
  marks+=line(350,48,350,175,'sa-target');scan='M105 75L210 110L330 137';
  tips=[tip(['先看方向','Start with trend'],['4h','4h']),tip(['结构确认','Check structure'],['1h','1h']),tip(['寻找入场','Time the entry'],['15m','15m'])];
 }else if(id==='S01'){
  type='grid';set('固定区间 · 四层买卖','Fixed range · four layers','对应库存分层卖出','Exit owned layers');
  marks+=rect(28,70,344,96);
  [76,104,132,160].forEach((y,i)=>{marks+=line(28,y,372,y,'sa-target')+text(366,y-6,'0'+(i+1),'sa-small','end');});
  const ps=[[30,89],[74,65],[120,151],[169,91],[212,133],[259,72],[308,152],[366,103]];
  marks+=path(curve(ps));[2,4,6].forEach(i=>marks+=focus(i/7,dot(...ps[i])+path('M'+ps[i][0]+' '+(ps[i][1]+10)+'l-3 5h6Z','sa-arrow')));
  scan=curve(ps);tips=[tip(['分层等待','Layered entries'],['01 / 04','01 / 04']),tip(['低位买入','Buy a layer'],['对应库存','Match inventory']),tip(['反弹卖出','Sell on recovery'],['不追涨补单','Stay in range'])];
 }else if(id==='S02'){
  type='entry-ladder';set('最多三次 · 共用止损','Three entries · one stop','总投入有上限','One capital cap');
  const ps=[[30,70],[82,94],[132,115],[190,139],[231,149],[277,136],[322,120],[370,111]];
  marks+=path(curve(ps));
  [[83,95,30],[147,120,44],[216,146,62]].forEach(([x,y,w],i)=>{marks+=focus(i/2,rect(x-9,y+6,w,12,'sa-bar','rx="3"')+text(x-2,y-9,['1×','1.5×','2.25×'][i],'sa-small'));});
  marks+=line(28,178,372,178,'sa-stop')+text(370,191,L('共同止损','Basket stop'),'sa-small','end');
  scan=curve(ps);tips=[tip(['第一层','Entry one'],['1×','1×']),tip(['第二层','Entry two'],['1.5×','1.5×']),tip(['最后一层','Final entry'],['2.25×','2.25×'])];
 }else if(id==='S04'){
  type='breakout';set('区间突破 · 回踩确认','Breakout · retest','回踩有效后再跟进','Confirm the retest');
  marks+=rect(28,108,204,52)+line(28,108,370,108,'sa-target')+text(34,153,L('原区间','Prior range'),'sa-small');
  const ps=[[28,144],[64,120],[99,149],[134,118],[171,141],[207,90],[247,108],[286,78],[326,66],[370,52]];
  marks+=path(curve(ps))+focus(.63,dot(247,108)+path('M241 123h12','sa-secondary'));
  scan=curve(ps);tips=[tip(['区间内','Inside range'],['等待突破','Wait for break']),tip(['突破后','After breakout'],['等待回踩','Wait for retest']),tip(['再次向上','Break resumes'],['确认后跟进','Confirm, then act'])];
 }else if(id==='S05'){
  type='depth';horizontal=true;set('买卖深度 · 扣除成本','Book depth · after costs','价差覆盖成本再行动','Require a net edge');
  marks='';
  const buy=[35,50,70,93,121],sell=[126,99,72,49,32];
  buy.forEach((v,i)=>{const y=63+i*24;marks+=focus(i/4,rect(184-v,y,v,12,'sa-bar','rx="3"')+rect(216,y,sell[i],12,'sa-bar-muted','rx="3"'));});
  marks+=text(38,47,L('买盘','Bids'),'sa-small')+text(362,47,L('卖盘','Asks'),'sa-small','end')+line(200,50,200,178,'sa-target')+line(184,186,216,186,'sa-rule')+text(200,199,L('价差','Spread'),'sa-small','middle');
  scan='M200 68L200 167';
  tips=[tip(['比较深度','Compare depth'],['买 / 卖','Bid / Ask']),tip(['交易成本','Trading costs'],['手续费 + 滑点','Fees + slippage']),tip(['剩余空间','Remaining edge'],['价差 − 成本','Spread − costs'])];
 }else if(id==='S06'){
  type='waves';set('拐点确认 · 等待延续','Turning points · continuation','第四浪后观察延续','Watch continuation');
  const ps=[[28,166],[94,100],[145,137],[213,67],[276,113],[367,51]];
  marks+=path(curve(ps));ps.slice(1).forEach(([x,y],i)=>marks+=focus((i+1)/5,dot(x,y)+text(x,y-12,''+(i+1),'sa-small','middle')));
  scan=curve(ps);tips=[tip(['确认端点','Confirm pivots'],['1 → 2','1 → 2']),tip(['等待回调','Wait for pullback'],['3 → 4','3 → 4']),tip(['观察延续','Watch extension'],['4 → 5','4 → 5'])];
 }else if(id==='S07'){
  type='price-volume';set('价格测试 · 成交量确认','Price test · volume check','价量共同确认','Price + volume');
  const ps=points([88,70,88,115,138,112,123,96,83,64,56],28,344);
  marks+=rect(28,102,229,40)+area(ps,uid,153)+path(curve(ps))+line(28,153,372,153,'sa-rule');
  marks+=bars([12,19,11,23,30,14,8,7,13,21,27,35,31],{base:197,cls:'sa-bar'});
  scan=curve(ps);tips=[tip(['价格下探','Price tests low'],['观察区间','Watch the range']),tip(['成交量','Volume test'],['缩量测试','Lighter volume']),tip(['再次向上','Price recovers'],['价量确认','Volume confirms'])];
 }else if(id==='S08'){
  type='inside-bars';set('母线区间 · 内包收敛','Parent bar · inside bars','收盘突破才行动','Wait for bar close');
  marks+=rect(85,66,226,99)+line(85,66,372,66,'sa-target')+line(85,165,372,165,'sa-target');
  const ys=[151,134,148,88,125,106,118,110,113,99,57,47];
  marks+=candles(ys,{x:35,span:326})+text(100,184,L('固定母线区间','Fixed parent range'),'sa-small');
  scan=poly(points(ys,35,326));tips=[tip(['母线范围','Parent range'],['先固定','Freeze first']),tip(['内包收敛','Inside bars'],['等待收盘','Wait for close']),tip(['闭合突破','Closed breakout'],['再行动','Then act'])];
 }else if(id==='S09-A'){
  type='spread';set('同链双池 · 净价差','Two pools · net spread','扣费后仍有空间','Positive after costs');
  const a=points([125,117,122,99,105,83,94,72,78],30,340),b=a.map(([x,y],i)=>[x,y+17+(i%3)*5]);
  marks+=path(curve(a)+curve([...b].reverse()).replace(/^M/,'L')+'Z','sa-band')+path(curve(a))+path(curve(b),'sa-secondary');
  marks+=text(30,69,'POOL A','sa-small')+text(30,184,'POOL B','sa-small')+focus(.6,line(242,85,242,113,'sa-spread-measure'));
  scan=curve(a);tips=[tip(['比较两池','Compare pools'],['同一资产','Same asset']),tip(['扣除成本','Subtract costs'],['手续费 + Gas','Fees + gas']),tip(['净价差','Net spread'],['再判断执行','Check execution'])];
 }else if(id==='S09-L'){
  type='liquidity-range';set('流动性分布 · 价格区间','Liquidity · price range','区间与库存一起看','Range + inventory');
  marks+=rect(106,53,180,123);
  marks+=bars([15,23,39,61,83,108,118,103,78,57,37,21,12],{x:34,span:331,base:177,width:17,cls:'sa-bar-muted'});
  marks+=line(106,52,106,182,'sa-boundary')+line(286,52,286,182,'sa-boundary')+rect(103,49,6,11,'sa-accent-fill','rx="3"')+rect(283,49,6,11,'sa-accent-fill','rx="3"');
  marks+=text(106,198,L('下限','Lower'),'sa-small','middle')+text(286,198,L('上限','Upper'),'sa-small','middle');
  scan='M110 122L280 122';tips=[tip(['价格区间','Price range'],['两侧有边界','Bounded range']),tip(['区间内','Within range'],['跟踪两币库存','Track both assets']),tip(['接近边界','Near boundary'],['按计划调整','Adjust to plan'])];
 }else if(id==='RX01'){
  type='event';set('消息发布 · 价格确认','Publication · price check','等待发布后的机会','Wait for the release');
  marks+=rect(161,45,211,132)+line(160,42,160,181,'sa-boundary')+text(160,196,L('正式发布','Published'),'sa-small','middle');
  const ps=points([120,116,122,119,121,115,156,137,101,106,83,74,62],28,344);
  marks+=path(curve(ps));scan=curve(ps);
  tips=[tip(['发布前','Before release'],['等待消息','Wait for news']),tip(['发布后','After release'],['观察波动','Watch reaction']),tip(['价格确认','Price confirms'],['再跟进','Then follow'])];
 }else if(id==='RX02-P'){
  type='source-flow';set('独立来源 · 去重核对','Original sources · dedup','热度还需价格确认','Require price proof');
  marks='';
  [64,100,136,172].forEach((y,i)=>{
   marks+=focus(i/3,rect(30,y-11,48,24,i===2?'sa-source-muted':'sa-source','rx="4"')+text(54,y+4,i===2?'A′':['A','B','','C'][i],'sa-small','middle'));
   marks+=path('M78 '+y+'C123 '+y+' 133 118 169 118',i===2?'sa-flow-muted':'sa-secondary');
  });
  marks+=rect(169,99,58,38,'sa-source','rx="6"')+text(198,123,L('去重','Filter'),'sa-small','middle')+path('M227 118C265 118 283 118 323 118');
  marks+=rect(323,99,47,38,'sa-source','rx="6"')+path('M338 119l6 6 13 -15','sa-tick');
  marks+=text(54,194,L('独立来源','Sources'),'sa-small','middle')+text(198,194,L('交叉核对','Cross-check'),'sa-small','middle')+text(346,194,L('价格确认','Price'),'sa-small','middle');
  scan='M78 100C123 100 133 118 169 118L323 118';
  tips=[tip(['原始消息','Original posts'],['独立来源','Separate sources']),tip(['重复传播','Repeated shares'],['只计一次','Count once']),tip(['消息成立','Sources checked'],['还需价格确认','Check spot price'])];
 }else if(id==='RX02-A'){
  type='attention';set('关注 · 互动 · 价格','Attention · engagement · price','现货走势再确认','Confirm spot price');
  marks+=bars([12,18,22,16,31,52,78,95,69,49,39,26],{x:36,span:328,base:178,width:11,cls:'sa-bar-muted'});
  marks+=bars([6,9,10,11,19,33,48,61,41,31,26,19],{x:46,span:328,base:178,width:5,cls:'sa-bar'});
  const ps=points([143,148,139,142,131,113,91,100,83,70,59,64],30,339);
  marks+=area(ps,uid,177)+path(curve(ps))+text(30,195,L('关注 / 互动','Attention / engagement'),'sa-small');
  scan=curve(ps);tips=[tip(['历史窗口','Past window'],['先做比较','Compare first']),tip(['热度上升','Attention rises'],['剔除异常','Filter anomalies']),tip(['价格走势','Spot price'],['独立确认','Separate check'])];
 }else if(id==='RX03-S'||id==='RX03-B'){
  type=id==='RX03-S'?'net-flow':'exchange-flow';
  set(id==='RX03-S'?'池内成交 · 净买入':'交易所 · 资金流入流出',id==='RX03-S'?'Pool swaps · net buying':'Exchange inflow / outflow','资金流与价格对照','Compare flow + price');
  const vals=id==='RX03-S'?[-15,21,-24,33,12,-9,47,29,-17,49,39,61]:[39,21,-17,16,-24,-41,-29,-49,-53,-35,-47,-38];
  marks+=line(28,121,372,121,'sa-target')+text(28,63,L(id==='RX03-S'?'买入':'流入',id==='RX03-S'?'Buy':'In'),'sa-small')+text(28,185,L(id==='RX03-S'?'卖出':'流出',id==='RX03-S'?'Sell':'Out'),'sa-small');
  marks+=bars(vals,{x:42,span:318,base:121,width:15,signed:true});
  const ps=points(id==='RX03-S'?[132,127,134,119,121,111,95,104,88,79,72,59]:[126,121,129,117,120,115,101,106,91,96,79,71],42,318);
  marks+=path(curve(ps));scan=curve(ps);
  tips=id==='RX03-S'?[tip(['成交记录','Swap records'],['剔除转账','Exclude transfers']),tip(['买卖对比','Compare swaps'],['计算净买入','Net buying']),tip(['价格再确认','Check price'],['局部池信号','Pool-level only'])]:[tip(['交易所实体','Exchange entities'],['核对地址','Verify addresses']),tip(['异常净流出','Net outflow'],['对照历史','Compare history']),tip(['价格突破','Price breakout'],['再考虑跟进','Then consider entry'])];
 }else if(id==='RX04'){
  type='unlock-protection';set('解锁批次 · 库存保护','Unlock batches · protect holdings','暂停新买入','Pause new buys');
  marks+=bars([9,12,16,57,19,10,14,92,18,11],{x:35,span:327,base:177,width:17,cls:'sa-bar-muted'});
  marks+=line(141,47,141,181,'sa-target')+line(289,47,289,181,'sa-target');
  const ps=[[28,71],[141,71],[141,98],[289,98],[289,132],[372,132]];
  marks+=path(roundedSteps(ps))+text(31,193,L('解锁量','Unlock volume'),'sa-small')+text(370,149,L('剩余库存','Holdings'),'sa-small','end');
  scan=roundedSteps(ps);tips=[tip(['已有库存','Existing holdings'],['关注解锁批次','Track unlocks']),tip(['消息确认','Event confirmed'],['暂停新买入','Pause entries']),tip(['证据变化','Evidence changes'],['按计划减仓','Reduce to plan'])];
 }else{
  type='deleveraging';set('持仓量回落 · 价格企稳','OI falls · price stabilizes','企稳后再考虑买入','Wait for stability');
  marks+=bars([99,115,108,94,73,56,42,29,24,26,25,23],{x:37,span:326,base:177,width:17,cls:'sa-bar-muted'});
  const ps=points([81,87,98,125,146,152,149,154,145,140,128,117],30,339);
  marks+=area(ps,uid,177)+path(curve(ps))+text(30,195,L('持仓量','Open interest'),'sa-small');
  scan=curve(ps);tips=[tip(['杠杆拥挤','Crowded leverage'],['先等待','Wait first']),tip(['持仓量下降','OI declines'],['去杠杆','Deleveraging']),tip(['现货企稳','Spot stabilizes'],['再判断机会','Assess the setup'])];
 }
 return {marks,scan,tips,caption,outcome,type,horizontal};
}

export function strategyArt(id){
 const uid='sa-area-'+(++serial),s=build(id,uid),tipData=JSON.stringify(s.tips).replaceAll('"','&quot;');
 // A legible static first frame is present before IntersectionObserver starts.
 return '<div class="strategy-art" data-art="'+id+'" data-chart="'+s.type+'" data-tips="'+tipData+'" data-horizontal="'+s.horizontal+'" style="--sa-spectrum:url(#'+uid+'-spectrum);--sa-spectrum-alt:url(#'+uid+'-spectrum-alt)">'+
 '<svg viewBox="0 0 400 240" role="img" aria-label="'+s.caption+L('，策略机制示意，不是实际行情或收益','; strategy illustration, not market data or returns')+'">'+
 '<defs>'+[false,true].map(reverse=>'<linearGradient class="sa-spectral-gradient" id="'+uid+'-spectrum'+(reverse?'-alt':'')+'" gradientUnits="userSpaceOnUse" x1="28" x2="372" y1="0" y2="0">'+Array.from({length:7},(_,i)=>'<stop offset="'+(i/6*100)+'%" style="stop-color:var(--s'+(reverse?7-i:i+1)+')"/>').join('')+'</linearGradient>').join('')+'<linearGradient id="'+uid+'" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--sa-secondary)" stop-opacity=".14"/><stop offset="1" stop-color="var(--sa-secondary)" stop-opacity="0"/></linearGradient></defs>'+
 '<text x="28" y="25" class="sa-heading">'+s.caption+'</text>'+
 s.marks+'<path class="sa-light-packet sa-packet-tail" pathLength="100" d="'+s.scan+'" aria-hidden="true"/><path class="sa-light-packet sa-packet-head" pathLength="100" d="'+s.scan+'" aria-hidden="true"/><path d="'+s.scan+'" data-scan-path fill="none" stroke="none"/>'+
 '<line class="sa-cursor" x1="200" x2="200" y1="43" y2="196"/>'+
 '<circle class="sa-scan-dot" cx="200" cy="118" r="3.4"/>'+
 '<g class="sa-quote" transform="translate(200 100)"><path class="sa-tooltip-tail" d="M-5 -4L0 2L5 -4Z"/><rect class="sa-tooltip" x="-53" y="-46" width="106" height="42" rx="7"/><text class="sa-tooltip-label" y="-30" text-anchor="middle">'+s.tips[1][0]+'</text><text class="sa-tooltip-value" y="-14" text-anchor="middle">'+s.tips[1][1]+'</text></g>'+
 '<path class="sa-footer-rule" d="M28 211H372"/><circle cx="31" cy="226" r="2.5" class="sa-outcome-dot"/><text x="42" y="230" class="sa-result">'+s.outcome+'</text>'+
 '</svg></div>';
}

// One clock and one restrained inspection gesture across every chart family.
// The data stays visible; the guide, local emphasis and callout describe the mechanism.
// Static until a mouse enters. Only the hovered chart animates; leaving stops immediately.
export function createStrategyArtMotion(){
 const active=new Map(),cache=new Map(),visible=new Set(),reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let raf=0,previous=0;
 const isReduced=()=>reduced.matches||new URLSearchParams(location.search).get('motion')==='reduced';
 function start(el,r){if(!visible.has(el))return;el.dataset.motion=isReduced()?'reduced':'active';active.set(el,r);sync();}
 function stop(el,r){r.hover=null;el.dataset.motion='idle';active.delete(el);sync();}
 function prepare(el){
  if(cache.has(el))return cache.get(el);
  const path=el.querySelector('[data-scan-path]'),length=path.getTotalLength();
  const samples=Array.from({length:241},(_,i)=>path.getPointAtLength(length*i/240));
  const r={el,samples,type:el.dataset.chart,tips:JSON.parse(el.dataset.tips),horizontal:el.dataset.horizontal==='true',quote:el.querySelector('.sa-quote'),cursor:el.querySelector('.sa-cursor'),dot:el.querySelector('.sa-scan-dot'),label:el.querySelector('.sa-tooltip-label'),value:el.querySelector('.sa-tooltip-value'),packets:[...el.querySelectorAll('.sa-light-packet')],focus:[...el.querySelectorAll('[data-focus]')],last:-1,t:.48,hover:null};
  el.onpointerenter=event=>{if(event.pointerType!=='mouse'||!visible.has(el))return;r.hover=null;start(el,r);};
  el.onpointermove=event=>{
   if(event.pointerType!=='mouse')return;
   const svg=el.querySelector('svg'),matrix=svg.getScreenCTM();if(!matrix)return;
   const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
   r.hover=Math.max(.06,Math.min(.94,(p.x-28)/344));active.set(el,r);if(isReduced())draw(r,r.hover);else if(!raf)sync();
  };
  el.onpointerleave=()=>stop(el,r);
  const button=el.closest?.('.sc-art-button');
  if(button){r.button=button;button.onfocus=()=>start(el,r);button.onblur=()=>stop(el,r);}
  cache.set(el,r);draw(r,.58);return r;
 }
 function draw(r,t,phase=t){
  const at=t*240,index=Math.min(239,Math.floor(at)),a=r.samples[index],b=r.samples[index+1],f=at-index;
  const x=a.x+(b.x-a.x)*f,y=a.y+(b.y-a.y)*f;
  // Callout stays inside the plot; endpoint markers remain exactly on the data.
  const qx=Math.max(82,Math.min(318,x)),qy=Math.max(84,Math.min(162,y-12));
  r.quote.setAttribute('transform','translate('+qx.toFixed(2)+' '+qy.toFixed(2)+')');
  r.dot.setAttribute('cx',x);r.dot.setAttribute('cy',y);
  r.packets.forEach((packet,i)=>packet.setAttribute('stroke-dashoffset',(-phase*100+(i===0?9:0)).toFixed(2)));
  const v=r.horizontal?[28,y,372,y]:[x,43,x,196];
  ['x1','y1','x2','y2'].forEach((k,i)=>r.cursor.setAttribute(k,v[i]));
  const cuts={breakout:[194,260],'entry-ladder':[137,216],waves:[145,276],'inside-bars':[119,331],event:[160,282],'source-flow':[169,227],'unlock-protection':[141,289]};
  const limits=cuts[r.type];
  const stage=limits?(x<limits[0]?0:x<limits[1]?1:2):Math.min(r.tips.length-1,Math.floor(t*r.tips.length));
  let [label,value]=r.tips[stage];
  if(r.type==='grid'){const layer=Math.max(1,Math.min(4,Math.round((y-76)/28)+1));label=L('价格所在层','Price layer');value=layer+' / 4';}
  const key=label+value;if(key!==r.last){r.label.textContent=label;r.value.textContent=value;r.last=key;}
  for(const mark of r.focus){
   const selected=r.type==='multi-timeframe'?Math.round(Number(mark.dataset.focus)*2)===stage:Math.abs(Number(mark.dataset.focus)-t)<.13;
   if(mark.classList.contains('is-active')!==selected)mark.classList.toggle('is-active',selected);
  }
 }
 function frame(now){
  raf=0;if(document.hidden||isReduced())return;
  const cycle=(now%18000)/18000,t=.06+.88*(.5-.5*Math.cos(cycle*Math.PI*2));
  const dt=Math.min(48,previous?now-previous:16),blend=1-Math.exp(-dt/110);previous=now;
  for(const [el,r] of active){if(!el.isConnected){active.delete(el);observer.unobserve(el);continue;}r.t+=((r.hover??t)-r.t)*blend;draw(r,r.t,(now%5000)/5000);}
  if(active.size)raf=requestAnimationFrame(frame);
 }
 function sync(){
  if(raf){cancelAnimationFrame(raf);raf=0;}previous=0;
  for(const [el] of active)el.dataset.motion=isReduced()?'reduced':document.hidden?'idle':'active';
  if(isReduced()){active.forEach(r=>draw(r,.58));return;}
  if(!document.hidden&&active.size)raf=requestAnimationFrame(frame);
 }
 const observer=new IntersectionObserver(entries=>{
  entries.forEach(({target,isIntersecting})=>{if(isIntersecting){visible.add(target);prepare(target);}else{visible.delete(target);target.dataset.motion='idle';active.delete(target);}});sync();
 },{threshold:.15});
 let listening=false;
 function listen(){if(listening)return;listening=true;reduced.addEventListener('change',sync);document.addEventListener('visibilitychange',sync);}
 function release(el){const r=cache.get(el);if(r?.button){r.button.onfocus=null;r.button.onblur=null;}el.dataset.motion='idle';el.onpointerenter=null;el.onpointermove=null;el.onpointerleave=null;visible.delete(el);active.delete(el);cache.delete(el);}
 return {observe(el){listen();observer.observe(el);},unobserve(el){observer.unobserve(el);release(el);sync();},disconnect(){observer.disconnect();for(const el of cache.keys())release(el);active.clear();sync();reduced.removeEventListener('change',sync);document.removeEventListener('visibilitychange',sync);listening=false;}};
}

export const STRATEGY_STORY={
 S03:[['均线向上','Upward trend'],['RSI 穿过 50','RSI crosses 50'],['按计划买入','Planned entry'],['横盘时反复进出','Whipsaws in sideways markets']],
 S00:[['大周期定方向','Higher timeframe'],['四维证据齐全','Four evidence layers'],['小周期找突破','Lower-timeframe break'],['缺少评分记录就等待','Wait if scoring records are missing']],
 S01:[['固定价格区间','Freeze the range'],['四层等待买入','Four staged entries'],['对应库存分层卖出','Exit owned layers'],['跌出区间就停止补单','Stop replenishing outside the range']],
 S02:[['出现回归信号','Mean-reversion signal'],['最多三层买入','At most three layers'],['共同止损退出','One basket stop'],['下跌不止时仍会亏损','Persistent declines still lose money']],
 S04:[['结构区间确认','Confirm structure'],['突破后回踩','Break and retest'],['再突破才入场','Enter on the next break'],['回踩失败则放弃','Skip a failed retest']],
 S05:[['读取盘口','Read the order book'],['扣除交易成本','Include trading costs'],['短时机会才执行','Act on a short window'],['费用可能吃掉价差','Fees may exceed the edge']],
 S06:[['确认波浪端点','Confirm turning points'],['等待第四浪回调','Wait for retracement'],['观察第五浪延续','Watch continuation'],['不重新数浪挽救持仓','Do not relabel a losing position']],
 S07:[['价格下探区间','Price tests the range'],['成交量配合测试','Volume confirms the test'],['确认后再入场','Enter after confirmation'],['形态不等于主力身份','Patterns do not identify a market actor']],
 S08:[['母线范围固定','Freeze the parent bar'],['内包线收敛','Inside-bar contraction'],['闭合突破才行动','Act on a closed breakout'],['未收盘突破可能撤回','An unclosed breakout can reverse']],
 'S09-A':[['同链比较价格','Compare on one chain'],['扣费后仍有空间','Positive after costs'],['原子执行检查','Atomic execution checks'],['失败交易也可能花 Gas','Failed transactions may cost gas']],
 'S09-L':[['选择价格区间','Select a price range'],['跟踪两币库存','Track both assets'],['按计划调整流动性','Adjust under the plan'],['撤流不等于换成稳定币','Removing liquidity retains inventory']],
 RX01:[['等正式消息发布','Wait for publication'],['观察发布后区间','Observe the new range'],['价格确认后跟进','Follow price confirmation'],['不抢未发布的结果','Never anticipate an unreleased result']],
 'RX02-P':[['找到独立原帖','Find original sources'],['剔除重复传播','Remove duplicate shares'],['现货突破才跟进','Require spot confirmation'],['热度不等于买盘','Attention is not buying pressure']],
 'RX02-A':[['关注与互动异动','Attention and engagement'],['与历史窗口比较','Compare like-for-like windows'],['等待现货确认','Wait for spot confirmation'],['数据缺失不当作低热度','Missing data is not low interest']],
 'RX03-S':[['读取指定池成交','Read registered pool swaps'],['剔除转账与重复','Filter transfers and duplicates'],['现货价格再确认','Confirm with spot price'],['局部池不代表全链','One pool does not cover the chain']],
 'RX03-B':[['读取交易所实体','Read exchange entities'],['确认异常净流出','Identify unusual net outflow'],['价格突破再跟进','Wait for price breakout'],['转入交易所不等于卖出','An exchange transfer is not a sale']],
 RX04:[['确认解锁批次','Confirm unlock batches'],['暂停新买入','Pause new entries'],['按证据减少库存','Reduce on evidence'],['只保护已有库存，不买入','Protect existing holdings; no new buys']],
 RX05:[['确认杠杆拥挤','Confirm leverage crowding'],['等待持仓量下降','Wait for OI reduction'],['现货企稳再跟进','Wait for spot stability'],['衍生品数据不代表做合约','Derivatives data does not enable futures']]
};

export function strategyTimeframe(s){const labels={S00:['15m / 1h / 4h','15m / 1h / 4h'],S01:['1h / 逐笔','1h / tick'],S02:['5m / 1h','5m / 1h'],S03:['5m','5m'],S04:['15m','15m'],S05:['盘口 / 逐笔','L2 / tick'],S06:['1h','1h'],S07:['1h','1h'],S08:['1h / 5m','1h / 5m'],'S09-A':['链上区块','On-chain blocks'],'S09-L':['1h / 链上','1h / on-chain'],RX01:['5m','5m'],'RX02-P':['30m / 15m','30m / 15m'],'RX02-A':['1h / 15m','1h / 15m'],'RX03-S':['30m / 15m','30m / 15m'],'RX03-B':['1d / 1h','1d / 1h'],RX04:['事件 / 1h','Event / 1h'],RX05:['15m / 5m','15m / 5m']};return L(...labels[s.id]);}
