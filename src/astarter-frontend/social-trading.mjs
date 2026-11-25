import {POSTS,TRADERS,MARKET} from './data-center-fixtures.mjs';

export function socialAvatarURL(trader={}){
 if(!trader||typeof trader!=='object')return null;
 // Scenario identities never borrow real people's profile pictures.
 if(TRADERS.some(t=>t.id===trader.id)||trader.simulated===true)return null;
 const value=trader.avatar_url||trader.avatarUrl;
 if(typeof value!=='string'||value.length>600)return null;
 try{
  const local=value.startsWith('/assets/'),url=new URL(value,'https://astarter.invalid');
  if(url.username||url.password||url.hash||[...url.searchParams.keys()].some(k=>/^(token|access_token|api_key|key|signature|auth)$/i.test(k)))return null;
  if(local&&url.origin==='https://astarter.invalid'&&url.pathname.startsWith('/assets/'))return url.pathname+url.search;
  return url.protocol==='https:'&&!url.port&&['pbs.twimg.com','avatars.githubusercontent.com'].includes(url.hostname)?url.href:null;
 }catch{return null;}
}

export function socialAvatar(trader={}){
 trader=trader&&typeof trader==='object'?trader:{};
 const seed=String(trader.id||trader.name||'account');let hash=0;for(const char of seed)hash=(hash*31+char.charCodeAt(0))>>>0;
 const colors=['#9174d2','#588fc2','#a875b0','#7c84cf','#ac8842','#b17677'];
 const shapes=[
  '<path d="m24 8 14 16-14 16L10 24Z" fill="currentColor" opacity=".16"/><path d="m24 8 14 16-14 16L10 24Z M10 24h28M24 8v32"/>',
  '<circle cx="24" cy="24" r="13" fill="currentColor" opacity=".13"/><ellipse cx="24" cy="24" rx="16" ry="7" transform="rotate(-35 24 24)"/><circle cx="24" cy="24" r="5" fill="currentColor" stroke="none"/>',
  '<rect x="11" y="11" width="11" height="11" rx="3" fill="currentColor" opacity=".75"/><rect x="26" y="11" width="11" height="11" rx="3"/><rect x="11" y="26" width="11" height="11" rx="3"/><rect x="26" y="26" width="11" height="11" rx="3" fill="currentColor" opacity=".3"/>',
  '<path d="m24 8 14 8v16l-14 8-14-8V16Z" fill="currentColor" opacity=".12"/><path d="m24 8 14 8v16l-14 8-14-8V16Z M10 16l14 8 14-8M24 24v16"/>'
 ];
 const url=socialAvatarURL(trader),safe=url?.replace(/&/g,'&amp;').replace(/"/g,'%22').replace(/'/g,'%27');
 return `<span class="df-avatar" data-avatar-kind="${url?'photo':'geometric'}" style="--avatar:${colors[hash%colors.length]}" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">${shapes[(hash>>>4)%shapes.length]}</svg>${url?`<span class="df-avatar-photo" style="background-image:url('${safe}')"></span>`:''}</span>`;
}

// Fictional accounts and fixed observations. No invented followers or engagement.
const notes=[
 ['BTC','watch','区间上沿挂单仍多。先看现货成交能否持续，不用一根上影线判断突破。','Offers remain near the range high. Watch persistent spot volume before calling a break.','成交增加，但价格尚未越过观察区间；维持等待。','Volume grows without a range break; the view remains on hold.'],
 ['ETH','bullish','稳定币流入与现货量同步增加。先核对接收地址，再判断资金是否真正进入买盘。','Stablecoin inflows align with spot volume. Check destinations before attributing buying demand.','价格温和走强，成交侧提供支持，地址身份仍需核对。','Price firms with volume support; address attribution still needs checking.'],
 ['XAU','watch','利率事件前，黄金与美元都可能短时反向。等公布后再比较实际利率。','Gold and dollar may reverse before the rate event. Compare real yields after the release.','初始联动减弱，继续等待事件结果。','The initial alignment weakens; waiting for the event outcome.'],
 ['LINK','bearish','短时流入集中于少数地址，价格没有同步。把归集与独立买盘分开看。','Flows are concentrated in a few addresses without matching price strength. Separate consolidation from demand.','价格继续回落，但暂不能把地址转账认定为出售。','Price eases, but address transfers still do not establish sales.'],
 ['SOL','watch','讨论很热，现货买盘却没跟上。回到区间中部时再看量能。','Discussion is hot without matching spot demand. Review volume at the middle of the range.','价格仍在区间内，讨论热度不足以改变等待结论。','Price remains in range; attention alone does not change the wait.'],
 ['HYPE','bearish','大额账户加仓时也在加杠杆。更关心反向波动会触发多少被动减仓。','Large accounts add leverage with size. Watch forced reductions if price reverses.','波动扩大，账户集中度仍高；继续检查杠杆变化。','Volatility grows and concentration stays high; leverage remains in focus.'],
 ['AAVE','bullish','利用率抬升伴随借贷需求增加，需要再对照实际使用和币价。','Higher utilization accompanies borrowing demand. Compare actual usage with price.','价格与借贷活动同向，但单一窗口还不够。','Price and lending activity align, but one window is not enough.'],
 ['BNB','bullish','盘口补单比前一窗口更稳定。若回踩后深度仍在，再考虑增加观察权重。','Book replenishment looks steadier. Review depth after a pullback before increasing conviction.','突破没有延续，原有偏多观点下调为观察。','The break fails to persist; the earlier bullish view is downgraded to watching.']
];
export function buildSocialPosts(){
 const added=TRADERS.flatMap((t,i)=>{
  const [asset,stance,text,textEn,update,updateEn]=notes[i%notes.length],a=MARKET.find(x=>x.symbol===asset),move=[.6,1.1,.2,-1.3,-.4,-.9,.8,-.6][i%8];
  const traded=t.id==='orbit'?'HYPE':t.assets[0],previous=POSTS.filter(p=>p.trader===t.id&&p.asset===traded&&p.side).sort((a,b)=>b.time.localeCompare(a.time))[0];
  const before=previous?.after??(10+i),after=Math.max(3,before+(i%3===0?-4:3)),side=previous?.side||(i%3===0?'空头':'多头');
  return [
   {id:`social-${t.id}-idea`,trader:t.id,time:`09:${String(10+i*5).padStart(2,'0')}`,kind:'研究观点',asset,text,textEn,stance,observedPrice:a.price/(1+move/100),impact:'先比较观点与账户行为，再对照后续行情；观点不是成交。',impactEn:'Compare the view with account activity and later price action. An opinion is not a fill.'},
   {id:`social-${t.id}-trade`,trader:t.id,time:t.id==='orbit'?'11:03':`11:${String(8+i*6).padStart(2,'0')}`,kind:'持仓变化',asset:traded,side,before,after,leverage:1+i%3,text:after>before?'分批增加观察仓，仍保留现金，跟踪成交后的价格变化。':'减少观察仓，保留剩余部分，等待下一轮条件。',textEn:after>before?'Adds to the watch position in stages, retaining cash and monitoring price.':'Trims the watch position and retains the remainder until the next condition.',impact:'加减仓与方向分开看。增加空仓不是看多，减仓也不一定代表反向。',impactEn:'Read size and direction separately. Adding a short is not bullish; reducing size is not necessarily a reversal.'},
   {id:`social-${t.id}-update`,trader:t.id,time:`13:${String(56-i*4).padStart(2,'0')}`,kind:'观点更新',asset,text:update,textEn:updateEn,stance:i===7?'watch':stance,observedPrice:a.price/(1+move/100),related:`social-${t.id}-idea`,impact:'更新与原始观点保留在同一账户记录中，价格变化不是跟随收益。',impactEn:'The update links to the original view. A price move is not copy-trading return.'}
  ];
 });
 return [...POSTS,...added].map(p=>({...p,time:p.time.padStart(5,'0'),date:'2026-10-24'})).sort((a,b)=>b.time.localeCompare(a.time)||a.id.localeCompare(b.id));
}
export const SOCIAL_POSTS=buildSocialPosts();
export function socialRows(posts=SOCIAL_POSTS,{kind='全部动态',asset='全部',query='',followed=[],saved=[]}={}){
 const q=query.trim().toLowerCase(),symbol=MARKET.find(a=>a.symbol.toLowerCase()===q)?.symbol;
 return posts.filter(p=>(kind==='全部动态'||kind==='已关注'&&followed.includes(p.trader)||kind==='已收藏'&&saved.includes(p.id)||kind===p.kind)&&(asset==='全部'||p.asset===asset)&&(!q||(symbol?p.asset===symbol:[p.text,p.textEn,p.searchText,p.asset,TRADERS.find(t=>t.id===p.trader)?.name].join(' ').toLowerCase().includes(q))))
  .sort((a,b)=>b.time.localeCompare(a.time)||a.id.localeCompare(b.id));
}
export function socialAssetThreads(posts=SOCIAL_POSTS){
 return [...new Set(posts.map(p=>p.asset))].map(symbol=>{
  const rows=posts.filter(p=>p.asset===symbol);
  return {symbol,accounts:new Set(rows.map(p=>p.trader)).size,positions:rows.filter(p=>p.side).length,ideas:rows.filter(p=>!p.side&&p.kind!=='账户盈亏').length,count:rows.length};
 }).sort((a,b)=>b.count-a.count||a.symbol.localeCompare(b.symbol));
}
