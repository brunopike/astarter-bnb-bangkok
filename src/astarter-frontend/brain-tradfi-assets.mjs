// Only the selected series is fetched. Curated IDs mirror the public TradFi archive.
const definitions = [
  ["oracle-gold","XAU","metals","Gold","黄金","黄金 金价 黃金 黄金现货 gold bullion xauusd","metalOracle","USD/troy oz","Chainlink","https://etherscan.io/address/0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6"],
  ["oracle-silver","XAG","metals","Silver","白银","白銀 银价 白银现货 silver bullion xagusd","metalOracle","USD/troy oz","Chainlink","https://etherscan.io/address/0x379589227b15F1a12195D3f2d90bBc9F31f95235"],
  ["wti","WTI","energy","WTI Crude Oil","WTI 原油","西德克萨斯 轻质 美油 原油 crude oil west texas intermediate cushing","oilSpot","USD/bbl","U.S. EIA","https://www.eia.gov/dnav/pet/hist/RWTCd.htm"],
  ["brent","BRENT","energy","Brent Crude Oil","布伦特原油","布蘭特 布兰特 原油 crude oil north sea","oilSpot","USD/bbl","U.S. EIA","https://www.eia.gov/dnav/pet/hist/RBRTEd.htm"],
  ["oracle-aapl","AAPL","stock","Apple","苹果","蘋果 苹果公司 iphone","stockOracle","USD/share","Chainlink","https://arbiscan.io/address/0x8d0CC5f38f9E802475f2CFf4F9fc7000C2E1557c"],
  ["oracle-msft","MSFT","stock","Microsoft","微软","微軟 windows","stockOracle","USD/share","Chainlink","https://arbiscan.io/address/0xDde33fb9F21739602806580bdd73BAd831DcA867"],
  ["oracle-nvda-arbitrum","NVDA","stock","NVIDIA","英伟达","英偉達 輝達 辉达 nvidia","stockOracle","USD/share","Chainlink","https://arbiscan.io/address/0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F"],
  ["oracle-amzn","AMZN","stock","Amazon","亚马逊","亞馬遜 amazon.com","stockOracle","USD/share","Chainlink","https://arbiscan.io/address/0xd6a77691f071E98Df7217BED98f38ae6d2313EBA"],
  ["oracle-googl","GOOGL","stock","Alphabet Class A","谷歌 · Alphabet A 类","谷歌 谷歌母公司 google alphabet","stockOracle","USD/share","Chainlink","https://arbiscan.io/address/0x1D1a83331e9D255EB1Aaf75026B60dFD00A252ba"],
  ["oracle-tsla-arbitrum","TSLA","stock","Tesla","特斯拉","電動車 tesla motors","stockOracle","USD/share","Chainlink","https://arbiscan.io/address/0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3"],
  ["taiex","TAIEX","index","Taiwan Capitalization Weighted Stock Index","台湾加权指数","台灣加權指数 台股 taiex twii taiwan index","cashIndex","points","Taiwan Stock Exchange","https://data.gov.tw/dataset/11755"],
  ["usd-index","USD Broad","index","Fed Broad U.S. Dollar Index","美联储广义美元指数","广义美元指数 美元指数 broad trade weighted dollar federal reserve","cashIndex","Jan 2006 = 100","Federal Reserve Board","https://www.federalreserve.gov/releases/h10/"],
  ["taifex-spf","SPF","futures","TAIFEX S&P 500 Index Futures","标普 500 指数期货","標普 标普 sp500 spx sp 500 sandp","indexFuture","points","Taiwan Futures Exchange","https://www.taifex.com.tw/enl/eng3/futDailyMarketView"],
  ["taifex-unf","UNF","futures","TAIFEX Nasdaq-100 Index Futures","纳斯达克 100 指数期货","纳指 納斯達克 納指 nasdaq 100 ndx","indexFuture","points","Taiwan Futures Exchange","https://www.taifex.com.tw/enl/eng3/futDailyMarketView"],
  ["oracle-spy-arbitrum","SPY","etf","SPDR S&P 500 ETF Trust","SPDR 标普 500 ETF","标普 500 标普500 標普 sp500 spx sp 500 sandp spider","fundOracle","USD/share","Chainlink","https://arbiscan.io/address/0x46306F3795342117721D8DEd50fbcF6DF2b3cc10"],
  ["oracle-qqq","QQQ","etf","Invesco QQQ Trust","景顺纳斯达克 100 ETF","納指 纳指 纳斯达克100 nasdaq 100 ndx","fundOracle","USD/share","Chainlink","https://etherscan.io/address/0xA1D955b4E582C784583df7071B8a3Fb6d4bcaC42"],
  ["eurusd","EUR/USD","fx","Euro / U.S. Dollar","欧元兑美元","欧元美元 歐元 欧元兑美元 euro dollar eurusd","fxReference","USD/EUR","ECB","https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A"],
  ["eurjpy","EUR/JPY","fx","Euro / Japanese Yen","欧元兑日元","欧日 欧元日元 歐元日圓 eurjpy","fxReference","JPY/EUR","ECB","https://data-api.ecb.europa.eu/service/data/EXR/D.JPY.EUR.SP00.A"],
  ["eurgbp","EUR/GBP","fx","Euro / Pound Sterling","欧元兑英镑","欧镑 欧元英镑 歐元英鎊 eurgbp","fxReference","GBP/EUR","ECB","https://data-api.ecb.europa.eu/service/data/EXR/D.GBP.EUR.SP00.A"],
  ["ust10y","US10Y","rates","U.S. 10-Year Treasury Yield","美国十年期国债收益率","美债 美債 美国国债 treasury bond yield 10-year ust10y","yield","%","Federal Reserve Board","https://www.federalreserve.gov/releases/h15/"],
];

const label=(en,zh)=>({en,zh});
export const tradfiGroups=[
  ['metals','Precious metals','贵金属'],['energy','Energy','能源'],['stock','U.S. equities','美股'],
  ['index','Indices','指数'],['futures','Index futures','指数期货'],['etf','ETFs','ETF'],
  ['fx','Foreign exchange','外汇'],['rates','Interest rates','利率']
].map(([id,en,zh])=>({id,label:label(en,zh)}));

const groupAliases={
  metals:['metal','metals','precious metals','贵金属','金属','貴金屬'],
  energy:['energy','crude oil','petroleum','能源','石油','原油'],
  stock:['stock','stocks','equity','equities','US stocks','US equities','US shares','美股','股票','美国股票','美國股票'],
  index:['index','indexes','indices','cash index','指数','指數'],
  futures:['future','futures','derivatives','index futures','期货','期貨','股指期货'],
  etf:['ETF','ETFs','fund','funds','exchange traded fund','基金','指数基金','指數基金'],
  fx:['FX','forex','currency','currencies','foreign exchange','currency pair','外汇','外匯','货币对','貨幣對','汇率','匯率'],
  rates:['rates','interest rates','yield','bonds','利率','债券','債券','收益率']
};
const instrumentTypes={
  metalOracle:label('Precious metal','贵金属'),oilSpot:label('Crude oil spot','原油现货'),
  stockOracle:label('U.S. equity','美股'),fundOracle:label('Exchange-traded fund','交易所交易基金'),
  cashIndex:label('Index','指数'),indexFuture:label('Index future','指数期货'),
  fxReference:label('Exchange rate','汇率'),yield:label('Government bond yield','国债收益率')
};
const measurements={
  metalOracle:label('Archived Chainlink reference price','Chainlink 归档参考价'),
  stockOracle:label('Archived Chainlink share price','Chainlink 归档股票参考价'),
  fundOracle:label('Archived Chainlink ETF share price','Chainlink 归档 ETF 份额参考价'),
  oilSpot:label('Daily spot price','日度现货价格'),cashIndex:label('Published index level','公布指数点位'),
  indexFuture:label('Nearest traded delivery month · close','最近有成交交割月份的收盘价'),
  fxReference:label('ECB daily reference rate','欧洲央行每日参考汇率'),
  yield:label('10-year constant maturity Treasury yield','十年期恒定期限国债收益率')
};
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
const rows=definitions.map(([id,symbol,group,name,nameZh,aliases,type,unit,provider,sourceUrl])=>({
  id,seriesId:id,symbol,group,name,nameZh,aliases,type,unit,provider,sourceUrl,kind:'tradfi',chain:null,address:null,
  archiveUrl:'/brain-evidence/tradfi/'+id+'.json',instrumentType:instrumentTypes[type],measurement:measurements[type],
  price:null,archiveStart:null,archiveEnd:null,archiveCount:null,archiveStatus:'pending'
}));
const byId=new Map(rows.map(asset=>[asset.id,asset]));
export function getTradfiAsset(id){return byId.get(id)??null;}
export function searchTradfiAssets(query='',group=''){
  const terms=String(query).trim().split(/\s+/).map(normalize).filter(Boolean);
  const exactGroup=Object.keys(groupAliases).find(id=>groupAliases[id].some(alias=>normalize(alias)===normalize(query)));
  if(exactGroup)return rows.filter(asset=>asset.group===exactGroup && (!group||asset.group===group));
  return rows.filter(asset=>{
    if(group && asset.group!==group)return false;
    const groupName=tradfiGroups.find(g=>g.id===asset.group).label;
    const fields=[asset.id,asset.symbol,asset.name,asset.nameZh,asset.aliases,asset.group,...groupAliases[asset.group],groupName.zh,groupName.en,asset.instrumentType.zh,asset.instrumentType.en].map(normalize);
    return terms.every(term=>fields.some(field=>field.includes(term)));
  });
}

const isoDay=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
export function readTradfiObservation(asset,body){
  if(!asset||body?.id!==asset.id||!Array.isArray(body.rows)||!body.rows.length)return null;
  const first=body.rows[0],last=body.rows.at(-1);
  if(!isoDay(first?.[0])||!isoDay(last?.[0])||first[0]>last[0]||!Number.isFinite(last[1]))return null;
  const contract=asset.type==='indexFuture'?last[6]:null;
  if(asset.type==='indexFuture' && !/^\d{6}$/.test(contract??''))return null;
  return {...asset,price:last[1],archiveStart:first[0],archiveEnd:last[0],archiveCount:body.rows.length,
    contractMonth:contract,archiveStatus:'ready'};
}
export async function refreshTradfiAsset(asset,{fetchImpl=globalThis.fetch,signal}={}){
  const definition=getTradfiAsset(asset.id);
  if(!definition)throw new TypeError('Unknown TradFi series');
  try{
    const timeout=AbortSignal.timeout(8000);
    const response=await fetchImpl(definition.archiveUrl,{signal:signal?AbortSignal.any([signal,timeout]):timeout,credentials:'omit',cache:'no-cache'});
    if(response.ok){
      const updated=readTradfiObservation(definition,await response.json());
      if(updated)return updated;
    }
  }catch(error){signal?.throwIfAborted();}
  return {...definition,archiveStatus:'unavailable'};
}
