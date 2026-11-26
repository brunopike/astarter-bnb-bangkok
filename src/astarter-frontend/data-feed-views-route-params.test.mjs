import test from 'node:test';
import assert from 'node:assert/strict';
import {createDataCenter} from './data-center.mjs';
import {MARKET} from './data-center-fixtures.mjs';
import {SOCIAL_VIEWS} from './data-feed-views.mjs';
import {socialAssetThreads} from './social-trading.mjs';
import {liveDataRoute} from './data-live-views.mjs';

// Address text that is not a known social view or asset must never reach the page as markup.
// The page has two paths: live data (the default) and preset data (data=demo). Each test checks both.
const MARKER='<b data-probe="df">probe</b>';
const PROBE=/data-probe/i,MARKUP=/<b data-probe/i,DEMO='&data=demo';
// Live social views and the page each one opens; any other view opens the default page, the social trends.
// The leaderboard also takes the preset names; the old Mastodon address now opens the trends page.
const LIVE_KIND={rank:'traders','排行榜':'traders','发现交易员':'traders','交易员排行':'traders',posts:'social','动态':'social','全部动态':'social',mastodon:'social'};
const LIVE_BODY={traders:/data-public-data="live-traders"/,social:/data-public-data="live-social"/};
const LIVE_NAV=/<nav class="dc-section-nav" aria-label="社媒动态">([\s\S]*?)<\/nav>/,DEMO_NAV=/<aside class="df-social-nav"><nav>([\s\S]*?)<\/nav>/;
// The trends request of the default live page.
const SOCIAL_REQUEST={resource:'social',selection_version:'0',limit:'50'};

const renderAt=search=>{
 const old=globalThis.location;
 try{
  globalThis.location=new URL('http://localhost/?page=social'+search);
  return createDataCenter({root:{scrollTop:0},rerender(){},notify(){},onResearch(){}}).render('social');
 }finally{if(old)globalThis.location=old;else delete globalThis.location;}
};

// Each page links to the other data view. The live page's "Preset" link carries the address, and
// the preset page's "Social trends" link opens the live page with data=live only. URLSearchParams encodes
// every markup character in a carried href, so the copy there is inert. Address text may appear nowhere else on the page.
const SWITCH=/<a class="dc-button" data-dc-link href="\?([^"]*)">(?:预设|社媒动向 →)<\/a>/g;
function modeSwitch(html){
 const links=[...html.matchAll(SWITCH)];
 assert.equal(links.length,1,'one link to the other data path');
 assert.match(links[0][1],/^[A-Za-z0-9%+*._&=-]*$/,'the carried address is URL-encoded');
 return new URLSearchParams(links[0][1]);
}
function outsideSwitch(html,carried={}){
 const query=modeSwitch(html);
 for(const [key,value] of Object.entries(carried))assert.equal(query.get(key),value,key);
 return html.replace(SWITCH,'');
}
// The page the live mode switch opens: the preset page with the same address.
const followSwitch=html=>{const query=modeSwitch(html);assert.equal(query.get('data'),'demo');query.delete('page');return renderAt('&'+query);};

// The live page as a visible browser tab loads it: the relay answers with `reply(query)`, or 503 when it returns nothing.
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function renderLive(search,reply=()=>null){
 const names=['location','document','navigator','fetch'],saved=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 const requests=[];
 try{
  const stubs={location:new URL('http://localhost/?page=social'+search),navigator:{onLine:true},
   document:{hidden:false,activeElement:null,body:{},addEventListener(){},querySelector(){return null;}},
   fetch:async url=>{
    const query=Object.fromEntries(new URL(url,'http://localhost').searchParams);requests.push(query);
    const body=reply(query);
    return body?Response.json({schema:'public-market-relay-v1',resource:query.resource,receivedAt:Date.now(),body}):new Response('{}',{status:503});
   }};
  for(const [name,value] of Object.entries(stubs))Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  const root={scrollTop:0,contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];}};
  const ui=createDataCenter({root,rerender(){},notify(){},onResearch(){}});
  ui.render('social');await settle();await settle();
  return {html:ui.render('social'),requests};
 }finally{for(const [name,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
}
const ADDRESS='0x'+'a'.repeat(40);
const leaderboard=(address=ADDRESS)=>({source:'Hyperliquid',network:'mainnet',currency:'USD',kind:'leaderboard',window:'month',ranking:'pnl',total:1,sourceAsOf:null,rows:[{rank:1,address,pnl:1,accountValue:null,roiPct:null,volume:null}]});

test('social view list is the four known views',()=>{
 assert.deepEqual(SOCIAL_VIEWS,['动态','发现交易员','发现资产','排行榜']);
 for(const [view,kind] of Object.entries(LIVE_KIND))assert.equal(liveDataRoute('social','view='+encodeURIComponent(view)).kind,kind,view);
 assert.equal(liveDataRoute('social','').kind,'social');
});

test('unknown social view from the address falls back to the default view of each path',async()=>{
 const html=renderAt('&view='+encodeURIComponent(MARKER)+DEMO);
 assert.doesNotMatch(outsideSwitch(html,{data:'live',view:null}),PROBE);
 assert.doesNotMatch(html,MARKUP);
 assert.match(html,/df-social-timeline/);
 // Live path: the default social page is the social trends page, unchanged by the unknown view. Its switch leaves
 // the view out (the preset path would fall back to its timeline anyway) and still carries the page.
 const live=renderAt('&view='+encodeURIComponent(MARKER));
 assert.doesNotMatch(outsideSwitch(live,{page:'social',data:'demo',view:null}),PROBE);
 assert.doesNotMatch(live,MARKUP);
 assert.match(live,LIVE_BODY.social);
 assert.equal(outsideSwitch(live),outsideSwitch(renderAt('')));
 const loaded=await renderLive('&view='+encodeURIComponent(MARKER));
 assert.deepEqual(loaded.requests,[SOCIAL_REQUEST]);
 assert.doesNotMatch(outsideSwitch(loaded.html,{view:null}),PROBE);
 assert.doesNotMatch(loaded.html,MARKUP);
 // The live address page is the one live page whose switch still carries the view: encoded there, and the preset
 // page it opens falls back to its timeline.
 const trader=renderAt('&trader='+ADDRESS+'&view='+encodeURIComponent(MARKER));
 assert.doesNotMatch(outsideSwitch(trader,{trader:ADDRESS,view:MARKER}),PROBE);
 assert.doesNotMatch(trader,MARKUP);
 const preset=followSwitch(trader);
 assert.match(preset,/df-social-timeline/);
 assert.doesNotMatch(preset,MARKUP);
});

test('unknown social asset from the address falls back to all assets',()=>{
 const html=renderAt('&asset='+encodeURIComponent(MARKER)+DEMO);
 assert.doesNotMatch(outsideSwitch(html,{data:'live',asset:null}),PROBE);
 assert.doesNotMatch(html,MARKUP);
 assert.match(html,/data-dc-filter="socialAsset" data-value="全部" aria-pressed="true"/);
 // Live path: no live social view reads the asset; the page is the default page.
 const live=renderAt('&asset='+encodeURIComponent(MARKER));
 assert.doesNotMatch(outsideSwitch(live,{asset:MARKER}),PROBE);
 assert.equal(outsideSwitch(live),outsideSwitch(renderAt('')));
});

test('known social asset from the address is still applied',()=>{
 const symbol=socialAssetThreads()[0].symbol;
 const html=renderAt('&asset='+encodeURIComponent(symbol)+DEMO);
 assert.match(html,new RegExp(`data-value="${symbol}" aria-pressed="true"`));
 assert.ok(html.includes(' · '+symbol),symbol);
 // Live path: the live pages have no asset filter; the switch takes the asset on to the preset page, which applies it.
 const live=renderAt('&asset='+encodeURIComponent(symbol));
 assert.equal(outsideSwitch(live,{asset:symbol}),outsideSwitch(renderAt('')));
 const preset=followSwitch(live);
 assert.match(preset,new RegExp(`data-value="${symbol}" aria-pressed="true"`));
 assert.ok(preset.includes(' · '+symbol),symbol);
});

test('known social views still render',()=>{
 // Each view's own body; a rejected view would fall back to the timeline and fail here.
 const BODY={'动态':/df-social-timeline/,'发现交易员':/class="df-discover"/,'发现资产':/class="df-asset-discover"/,'排行榜':/data-dc-filter="traderRank"/};
 assert.deepEqual(Object.keys(BODY),SOCIAL_VIEWS);
 for(const view of SOCIAL_VIEWS){
  const html=renderAt('&view='+encodeURIComponent(view)+DEMO);
  assert.doesNotMatch(html,/data-probe/,view);
  assert.match(html,/df-social/,view);
  assert.match(html,BODY[view],view);
  for(const other of SOCIAL_VIEWS)if(other!==view)assert.doesNotMatch(html,BODY[other],view+' / '+other);
 }
 // Live path: each live view opens its own page and no other.
 for(const [view,kind] of Object.entries(LIVE_KIND)){
  const html=renderAt('&view='+encodeURIComponent(view));
  assert.doesNotMatch(html,/data-probe/,view);
  assert.match(html,LIVE_BODY[kind],view);
  for(const other of Object.keys(LIVE_BODY))if(other!==kind)assert.doesNotMatch(html,LIVE_BODY[other],view+' / '+other);
 }
});

test('asset found only in the market list is still applied',()=>{
 // signal-tracking.mjs links to ?page=social&asset=SUI; SUI is in MARKET but has no social thread.
 assert.ok(MARKET.some(a=>a.symbol==='SUI'));
 assert.ok(!socialAssetThreads().some(row=>row.symbol==='SUI'));
 const html=renderAt('&asset=SUI'+DEMO);
 assert.match(html,/data-dc-filter="socialAsset" data-value="全部" aria-pressed="false"/);
 assert.ok(html.includes(' · SUI</span>'));
 // Live path: the switch takes the asset on to the preset page, which applies it.
 const live=renderAt('&asset=SUI');
 assert.equal(outsideSwitch(live,{asset:'SUI'}),outsideSwitch(renderAt('')));
 const preset=followSwitch(live);
 assert.match(preset,/data-dc-filter="socialAsset" data-value="全部" aria-pressed="false"/);
 assert.ok(preset.includes(' · SUI</span>'));
});

test('the live leaderboard shows a public address only after the relay check accepts it',async()=>{
 // The leaderboard writes the address as given, so the response check is what keeps outside text out. Trader
 // rankings have their own tab (view=rank); its switch opens the preset leaderboard.
 const shown=await renderLive('&view=rank',query=>query.resource==='traders'?leaderboard():null);
 assert.deepEqual(shown.requests,[{resource:'traders'}]);
 assert.match(shown.html,LIVE_BODY.traders);
 assert.ok(shown.html.includes(`<span title="${ADDRESS}">0xaaaaaa…aaaaaa</span>`));
 const loaded=await renderLive('&view=rank',query=>query.resource==='traders'?leaderboard(MARKER):null);
 assert.deepEqual(loaded.requests,[{resource:'traders'}]);
 assert.doesNotMatch(outsideSwitch(loaded.html,{view:'排行榜'}),PROBE);
 assert.match(loaded.html,/来源暂不可用/);
 assert.match(followSwitch(loaded.html),/data-dc-filter="traderRank"/);
 // A trader address from the page address that is not a public address is never requested or shown.
 const trader=await renderLive('&trader='+encodeURIComponent(MARKER),()=>leaderboard());
 assert.deepEqual(trader.requests,[]);
 assert.doesNotMatch(outsideSwitch(trader.html,{trader:MARKER}),PROBE);
 assert.match(trader.html,/公开地址无效/);
});

test('accepted social views are exactly the views the page navigation links to',()=>{
 const views=html=>[...html.matchAll(/href="\?([^"]*)"/g)].map(m=>new URLSearchParams(m[1].replaceAll('&amp;','&'))).filter(p=>p.get('page')==='social'&&!p.has('trader')&&p.has('view'));
 // A link opens a view on the path it leads to: the preset path with data=demo, the live path otherwise.
 const opens=p=>{
  if(p.get('data')!=='demo')return liveDataRoute('social',p).kind;
  const link=(renderAt('&view='+encodeURIComponent(p.get('view'))+DEMO).match(DEMO_NAV)?.[1]??'').match(/<a class="selected" data-dc-link href="\?([^"]*)">/);
  return link?new URLSearchParams(link[1]).get('view'):null;
 };
 // The live leaderboard maps to the preset leaderboard. Both the preset leaderboard and trader discovery
 // link back to the live leaderboard. The preset timeline handles live trends and the old Mastodon
 // address. Asset discovery opens the live social trends page, the default destination.
 const PRESET={...Object.fromEntries(SOCIAL_VIEWS.map(view=>[view,view])),rank:'排行榜',posts:'动态','全部动态':'动态',mastodon:'动态'};
 const meant=p=>p.get('data')==='demo'?PRESET[p.get('view')]:LIVE_KIND[p.get('view')]??'social';
 const demoNav=renderAt(DEMO).match(DEMO_NAV);
 assert.ok(demoNav);
 assert.deepEqual(views(demoNav[1]).map(p=>p.get('view')),SOCIAL_VIEWS);
 for(const search of [...SOCIAL_VIEWS.map(view=>'&view='+encodeURIComponent(view)),'&asset=SUI'])
  for(const p of views(renderAt(search+DEMO))){
   assert.ok(SOCIAL_VIEWS.includes(p.get('view')),search+' -> '+p);
   assert.equal(opens(p),meant(p),search+' -> '+p);
  }
 // Live path: the nav links to the default trends page and the leaderboard. A link that leaves for the preset path
 // (the leaderboard switch) names a preset view.
 const liveNav=renderAt('').match(LIVE_NAV);
 assert.ok(liveNav);
 assert.deepEqual([...liveNav[1].matchAll(/href="\?([^"]*)"/g)].map(m=>m[1].replaceAll('&amp;','&')),['page=social','page=social&view=rank']);
 for(const search of [...Object.keys(LIVE_KIND).map(view=>'&view='+encodeURIComponent(view)),'&asset=SUI',''])
  for(const p of views(renderAt(search))){
   assert.ok(p.get('data')==='demo'?SOCIAL_VIEWS.includes(p.get('view')):Object.hasOwn(LIVE_KIND,p.get('view')),search+' -> '+p);
   assert.equal(opens(p),meant(p),search+' -> '+p);
  }
});

// Preset path only: the live trader page has no profile tabs and does not read `view`.
test('trader profile tab from the address is looked up only among its own names',()=>{
 const pressed=html=>[...html.matchAll(/data-dc-filter="traderTab" data-value="([^"]*)" aria-pressed="true"/g)].map(m=>m[1]);
 for(const [view,tab] of [['positions','持仓'],['trades','交易记录'],['history','历史动态'],['performance','表现分析']])
  assert.deepEqual(pressed(renderAt('&data=demo&trader=north&view='+view)),[tab],view);
 assert.match(renderAt('&data=demo&trader=north&view=performance'),/class="df-performance"/);
 assert.deepEqual(pressed(renderAt('&data=demo&trader=north')),['持仓'],'no view');
 for(const view of ['','constructor','toString','valueOf','hasOwnProperty','__proto__',MARKER]){
  const html=renderAt('&data=demo&trader=north&view='+encodeURIComponent(view));
  assert.deepEqual(pressed(html),['持仓'],view);
  assert.doesNotMatch(html,/class="df-performance"/,view);
  assert.doesNotMatch(html,MARKUP,view);
 }
});
