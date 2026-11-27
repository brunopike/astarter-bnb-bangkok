import {notes as archiveNotes} from './brain-case-notes.mjs';
import {tradfiGroups} from './brain-tradfi-assets.mjs';
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

const bilingual=value=>pair(value.zh,value.en);
const nativeValue=new Intl.NumberFormat('en-US',{maximumFractionDigits:8});
function createTradfiScope(asset){
  const label=pair(asset.symbol,asset.symbol),name=pair(asset.nameZh,asset.name);
  const type=bilingual(asset.instrumentType),measurement=bilingual(asset.measurement);
  const pending=asset.archiveStatus==='unavailable'?pair('归档暂不可用','Archive unavailable'):pair('等待读取归档','Awaiting archive');
  const ready=asset.archiveStatus==='ready' && isNumber(asset.price);
  const text=ready?nativeValue.format(asset.price)+(asset.unit==='%'?'%':' '+asset.unit):null;
  const quote=ready?pair(text,text):pending;
  const observed=ready?pair(asset.archiveEnd,asset.archiveEnd):pending;
  const coverage=ready?asset.archiveStart+' — '+asset.archiveEnd:null;
  const count=ready?nativeValue.format(asset.archiveCount):null;
  const countLabel=count?pair(count+' 条',count+' observations'):pending;
  const source=pair(asset.provider,asset.provider),identity=pair(asset.seriesId,asset.seriesId);
  const metrics=[field('工具类型','Instrument',type),field('数据口径','Measure',measurement),field('来源','Source',source)];
  let delivery=null;
  if(asset.type==='indexFuture'){
    delivery=ready?asset.contractMonth.slice(0,4)+'-'+asset.contractMonth.slice(4):null;
    metrics.push(field('交割月份','Delivery month',delivery?pair(delivery,delivery):pending));
  }
  const archiveRows=[field('观察日','Observation date',observed),field('覆盖区间','Coverage',coverage?pair(coverage,coverage):pending),field('归档观察数','Archived observations',countLabel)];
  const identityRows=[field('标的','Instrument',name),field('归档序列','Archive series',identity)];
  const unit=pair(asset.unit,asset.unit);
  const receipt=pair('当前档案收录来源公布的观察值。','This archive contains observations published by the source.');
  const phase=(zh,en,rows)=>({title:pair(zh,en),source,rows:rows.map(({label,value})=>[...label,value])});
  const tape={asOf:ready?asset.archiveEnd:null,label:pair('归档回放','Archive replay'),phases:[
    phase('确定研究标的','Identify instrument',identityRows),
    phase('读取归档记录','Read archived observations',[field('归档观察值','Archived observation',quote),...archiveRows.slice(0,1)]),
    phase('核对报价口径','Check the measure',metrics),
    phase('核对历史覆盖','Check historical coverage',archiveRows),
    phase('索引来源','Index source',[...identityRows.slice(1),field('发布方','Publisher',source)])
  ]};
  const records=[
    [name,measurement],[pair('工具类型','Instrument type'),type],[pair('归档行情','Archived Market Data'),quote],
    [pair('计量口径','Measure'),measurement],[pair('证据索引','Evidence index'),identity],
    [pair('报价单位','Unit'),unit],[pair('归档观察值','Archived observation'),quote],[pair('观察日','Observation date'),observed],
    [pair('覆盖区间','Coverage'),coverage?pair(coverage,coverage):pending],[pair('数据来源','Source'),source],
    [pair('归档观察数','Archived observations'),countLabel],[pair('研究依据','Research evidence'),receipt],
    delivery?[pair('交割月份','Delivery month'),pair(delivery,delivery)]:[pair('发布方','Publisher'),source],
    [pair('复盘参照','Review reference'),quote]
  ];
  const notes=records.map(([title,body],index)=>({...archiveNotes[index],title,body,sourceUrl:asset.sourceUrl}));
  return {asset,label,marketLabel:pair(asset.nameZh+' · '+asset.provider,asset.name+' · '+asset.provider),notes,tape,
    memory:{label,rows:[...identityRows,...metrics,...archiveRows]},rows:[asset],marketRows:ready?[asset]:[],
    asOf:ready?asset.archiveEnd:null,quote,tradfiMetrics:metrics,change:null,volume:null,liquidity:null,providers:asset.provider};
}

function createAllCategoriesScope(catalog){
  const crypto=catalog.filter(asset=>asset.kind!=='tradfi');
  const tradfi=catalog.filter(asset=>asset.kind==='tradfi');
  const cryptoScope=createResearchScope(null,crypto);
  const groups=tradfiGroups.map(group=>({...group,assets:tradfi.filter(asset=>asset.group===group.id)})).filter(group=>group.assets.length);
  const label=pair('All','All');
  const counts=pair('加密资产 '+crypto.length+' · 传统金融 '+tradfi.length,'Crypto '+crypto.length+' · TradFi '+tradfi.length);
  const directory=pair('从资产选择器选择标的，可查看该序列的归档值、单位与观察日。','Select an instrument to see its archived observation, unit and date.');
  const groupRows=groups.map(group=>field(group.label.zh,group.label.en,join(group.assets.map(asset=>asset.symbol))));
  const groupLabel=pair(groups.map(group=>group.label.zh).join('、'),groups.map(group=>group.label.en).join(', '));
  const units=join(tradfi.map(asset=>asset.unit));
  const cryptoSources=cryptoScope.providers,tradfiSources=join(tradfi.map(asset=>asset.provider));
  const capture=timestamp(cryptoScope.asOf);
  const mapped=[
    note(...label,counts),note('加密资产网络','Crypto networks',join(crypto.map(asset=>brainChainName(asset.chain)))||missing),
    note('传统金融类别','TradFi categories',groupLabel),note('传统金融归档','TradFi archives',directory),
    note('来源索引','Source index',join([typeof cryptoSources==='string'?cryptoSources:null,tradfiSources])),
    note('加密资产来源','Crypto sources',cryptoSources),note('加密资产美元报价','Crypto USD quotes',cryptoScope.notes[6].body),
    note('加密快照采集时间','Crypto capture time',capture),note('加密资产流动性','Crypto liquidity',cryptoScope.liquidity),
    note('传统金融来源','TradFi sources',tradfiSources),note('归档计量单位','Archive units',units),
    note('传统金融标的','TradFi instruments',join(tradfi.map(asset=>asset.symbol))),
    note('加密资产成交额覆盖','Crypto volume coverage',cryptoScope.volume),
    note('归档查询','Archive lookup',directory)
  ];
  const notes=mapped.map((entry,index)=>({...archiveNotes[index],...entry}));
  const lines=(zh,en,source,rows)=>({title:pair(zh,en),source,rows:rows.map(({label,value})=>[...label,value])});
  const tape={asOf:cryptoScope.asOf,timeLabel:pair('加密快照采集时间','Crypto capture time'),label,phases:[
    lines('研究范围','Research scope',label,[field('加密资产','Crypto assets',String(crypto.length)),field('传统金融标的','TradFi instruments',String(tradfi.length))]),
    lines('加密资产美元报价','Crypto USD quotes',cryptoSources,cryptoScope.marketRows.slice(0,5).map(row=>field(row.symbol,row.symbol,amount(row.price)))),
    lines('传统金融标的','TradFi instruments',tradfiSources,groupRows),
    lines('核对计量口径','Check units',label,[field('加密快照时间','Crypto capture time',capture),field('传统金融单位','TradFi units',units)]),
    lines('核查来源','Check sources',label,[field('加密资产来源','Crypto sources',cryptoSources),field('传统金融来源','TradFi sources',tradfiSources)])
  ]};
  return {asset:null,label,marketLabel:counts,notes,tape,rows:catalog,marketRows:cryptoScope.marketRows,
    asOf:null,cryptoAsOf:cryptoScope.asOf,tradfiGroups:groups,cryptoCount:crypto.length,tradfiCount:tradfi.length,
    memory:{label,rows:[field('资产类别','Asset classes',counts),...groupRows,field('加密快照时间','Crypto capture time',capture)]},
    quote:null,change:null,volume:null,liquidity:null,providers:join([typeof cryptoSources==='string'?cryptoSources:null,tradfiSources])};
}

export function createResearchScope(asset,catalog) {
  if(asset?.kind==='tradfi')return createTradfiScope(asset);
  if(!asset && catalog.some(row=>row.kind==='tradfi'))return createAllCategoriesScope(catalog);
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
