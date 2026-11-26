import {notes as archiveNotes} from './brain-case-notes.mjs';
import {watchChain} from './market-watchlist.mjs';

const pair=(zh,en)=>[zh,en];
const missing=pair('暂无数据','Unavailable');
const isNumber=value=>typeof value==='number'&&Number.isFinite(value);
const formatUSD=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumSignificantDigits:7});
const compactUSD=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2});
const amount=(value,compact=false)=>isNumber(value)?(compact?compactUSD:formatUSD).format(value):missing;
const timestamp=value=>value?value.replace('T',' ').slice(0,19)+' UTC':missing;
export const brainChainName=key=>key?({bitcoin:'Bitcoin',cardano:'Cardano',dogecoin:'Dogecoin'}[key]??watchChain(key)):null;
const chainName=brainChainName;
const join=values=>[...new Set(values.filter(Boolean))].join(' · ');
const note=(zh,en,body,sourceUrl)=>({title:pair(zh,en),body:Array.isArray(body)?body:pair(body,body),sourceUrl});
const field=(zh,en,value)=>({label:pair(zh,en),value});
const change=value=>isNumber(value)?(value>0?'+':'')+value.toLocaleString('en-US',{maximumFractionDigits:2})+'%':missing;

export function createResearchScope(asset,catalog) {
  const rows=asset?[asset]:catalog;
  const sources=join(rows.map(row=>row.provider));
  const chains=[...new Set(rows.map(row=>row.chain).filter(Boolean))];
  const networkNames=chains.map(chainName);
  const latest=rows.map(row=>row.receivedAt).filter(Boolean).sort().at(-1)??null;
  const label=asset?pair(asset.symbol,asset.symbol):pair('全网资产','All assets');
  const marketRows=rows.filter(row=>isNumber(row.price));
  const liquidRows=rows.filter(row=>isNumber(row.liquidity));
  const volumeRows=rows.filter(row=>isNumber(row.volume));
  const scopeName=asset?asset.name:pair('全网记忆快照','Network memory snapshot');
  const chainLabel=asset?(chainName(asset.chain)||pair('未提供网络','Network not supplied')):(networkNames.join(' · ')||missing);
  const identity=asset?(asset.address||asset.id):pair('按网络与资产标识归档','Indexed by network and asset identity');
  const providers=sources||missing;
  const asOf=asset?.asOf||null;
  const observedAt=timestamp(latest);
  const symbolRows=marketRows.slice(0,6).map(row=>row.symbol+' '+formatUSD.format(row.price));
  const prices=asset?amount(asset.price):(symbolRows.join(' · ')||missing);
  const liquidity=asset?amount(asset.liquidity,true):pair('快照中有 '+liquidRows.length+' 项流动性记录。',liquidRows.length+' assets have a liquidity observation.');
  const volume=asset?amount(asset.volume,true):pair('快照中有 '+volumeRows.length+' 项 24 小时成交额。',volumeRows.length+' assets have 24h volume.');
  const marketCoverage=pair('已收录 '+rows.length+' 个资产，覆盖 '+chains.length+' 个已识别网络。',rows.length+' assets across '+chains.length+' identified networks in this snapshot.');
  const sourceUrl=asset?.sourceUrl;
  const evidenceFields=['price','volume','liquidity','change'];
  const evidenceCoverage=asset?evidenceFields.filter(key=>isNumber(asset[key])).length:marketRows.length;
  const venue=asset?(asset.venue||asset.provider||missing):(join(rows.map(row=>row.venue))||providers);
  const threshold=pair('发布策略需要独立来源、可成交深度和明确的失效条件。','A strategy requires independent sources, executable depth and an invalidation condition.');
  const isPool=asset?.kind==='contract';
  const dailyChange=asset && isNumber(asset.change)?'24h '+change(asset.change):null;
  const marketSummary=asset?join([prices,dailyChange,venue].filter(value=>typeof value==='string'))||missing:marketCoverage;
  const memoryIndex=asset?join([asset.symbol,chainName(asset.chain),asset.provider,latest?timestamp(latest):null]):
    pair('快照按网络、资产标识和采集时间关联。','Snapshots are linked by network, asset identity and capture time.');
  const volumeLabel=isPool?pair('池内 24h 成交额','Pool 24h volume'):pair('24h 成交额','24h volume');
  const reviewBaseline=asset?volumeLabel.map((label,index)=>label+' · '+(isNumber(asset.volume)?volume:missing[index])):volume;
  const research=[
    asset?note(asset.symbol,asset.symbol,asset.name,sourceUrl):note(...scopeName,marketCoverage),
    note('链上身份','On-chain identity',asset?identity:chainLabel,sourceUrl),
    note('市场快照','Market snapshot',marketSummary,sourceUrl),
    note('策略条件','Strategy criteria',threshold),
    note('记忆索引','Memory index',memoryIndex),
    note('网络与地址','Network and address',asset?.address?chainName(asset.chain)+' · '+asset.address:chainLabel,sourceUrl),
    note('美元报价','USD quote',prices,sourceUrl),
    note('采集时间','Capture time',observedAt,sourceUrl),
    note(isPool?'池内流动性':'流动性',isPool?'Pool liquidity':'Liquidity',liquidity,sourceUrl),
    note('报价来源','Quote source',venue,sourceUrl),
    note('证据覆盖','Evidence coverage',asset?pair('价格、涨跌、成交额、流动性四项中已有 '+evidenceCoverage+' 项。',evidenceCoverage+' of four observed fields: price, change, volume and liquidity.'):pair(marketRows.length+' 个资产有可核对的美元报价。',marketRows.length+' assets have a USD quote.')),
    note('自主交易回执','Manual trade receipt',pair('此快照未附用户成交回执。','No user trade receipt accompanies this snapshot.')),
    note('AI 交易回执','LensWave receipt',pair('此快照未附 AI 交易订单回执。','No LensWave order receipt accompanies this snapshot.')),
    note('复盘参照','Review baseline',reviewBaseline,sourceUrl)
  ].map((entry,i)=>({...archiveNotes[i],...entry}));
  const inspectRows=asset?[
    field('网络','Network',chainLabel),field('资产标识','Asset identity',identity),
    field('报价来源','Quote source',providers),field('采集时间','Captured',observedAt)
  ]:[
    field('资产','Assets',String(rows.length)),field('网络','Networks',networkNames.join(' · ')||missing),
    field('来源','Sources',providers),field('最近采集','Last capture',observedAt)
  ];
  const phase=(zh,en,source,entries)=>({title:pair(zh,en),source,rows:entries.map(({label,value})=>[...label,value])});
  const tape={asOf:latest,label:pair('快照回放','Snapshot replay'),phases:[
    phase('确定研究范围','Resolve scope',label,[
      field('研究对象','Subject',scopeName),field('网络','Networks',chainLabel),field('资产标识','Asset identity',identity)]),
    phase('读取公开行情','Read public quotes',providers,asset?[
      field('美元报价','USD quote',prices),field('24h 涨跌','24h change',change(asset.change)),field(...volumeLabel,volume)
    ]:marketRows.slice(0,6).map(row=>field(row.symbol,row.symbol,amount(row.price))).concat(marketRows.length?[]:[field('报价','Quote',missing)])),
    phase('核对流动性','Check liquidity',providers,[
      field(isPool?'池内流动性':'流动性',isPool?'Pool liquidity':'Liquidity',liquidity),field('报价来源','Quote source',venue)]),
    phase('检查执行依据','Check execution evidence',label,[
      field('策略','Strategy',pair('快照未附','Not in snapshot')),field('订单回执','Order receipt',pair('快照未附','Not in snapshot'))]),
    phase('索引证据','Index evidence',providers,[
      field('来源','Source',providers),...(asOf?[field('数据时点','Source timestamp',timestamp(asOf))]:[]),field('采集时间','Captured',observedAt)])
  ]};
  const marketLabel=asset?join([asset.symbol,chainName(asset.chain),asset.provider]):label;
  return {asset,label,marketLabel,notes:research,tape,memory:{label,rows:inspectRows},rows,marketRows,asOf:latest,
    quote:asset?prices:null,change:asset?change(asset.change):null,volume,liquidity,providers};
}
