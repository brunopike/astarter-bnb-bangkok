const DAY = 86_400_000;
const LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';
const SOURCES = {
  btc: {
    name: 'The Commoner Bitcoin ETF Tracker by TFTC',
    url: 'https://www.tftc.io/bitcoin-etf-flows',
    dataUrl: 'https://www.tftc.io/bitcoin-etf-flows/data.json',
    upstreamName: 'SoSoValue and Farside Investors',
    upstreamUrl: 'https://www.tftc.io/bitcoin-etf-flows/methodology'
  },
  eth: {
    name: 'GrowYourEthereum, Ethereum ETF flows',
    url: 'https://growyourethereum.com/data/ethereum-etf-flows',
    dataUrl: 'https://growyourethereum.com/datasets/eth-etf-flows.json',
    upstreamName: 'Farside Investors',
    upstreamUrl: 'https://farside.co.uk/ethereum-etf-flow-all-data/'
  }
};

const ETH_CASH_SOURCE = {
  name:'CoinClass',
  url:'https://coinclass.com/eth-etf#matrix',
  dataUrl:'https://coinclass.com/eth-etf',
  unit:'US$ millions',
  precisionUsd:100_000,
  licenseUrl:'https://coinclass.com/terms'
};

export const ETH_FLOW_FUNDS = Object.freeze(['ETH','ETHA','ETHB','ETHE','ETHV','ETHW','EZET','FETH','MSSE','QETH','TETH']);
const fundPage = (fund,canonical=false) => 'https://coinclass.com/etf/fund/'+(canonical?fund:fund.toLowerCase());
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const ticker = /^[A-Z][A-Z0-9]{0,9}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function tradingDate(date, now) {
  if (typeof date !== 'string' || !datePattern.test(date)) return false;
  const time = new Date(date);
  return Number.isFinite(+time) && +time <= now && time.toISOString().slice(0, 10) === date
    && time.getUTCDay() > 0 && time.getUTCDay() < 6;
}

function usd(value, multiplier) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value * multiplier) > Number.MAX_SAFE_INTEGER / 100) {
    throw new Error('Invalid ETF flow amount');
  }
  return multiplier === 1 ? value : Math.round(value * multiplier);
}

function decodeEtf(asset, data, receivedAt) {
  const bitcoin = asset === 'btc';
  const rows = bitcoin ? data?.days : data?.daily;
  const expectedUnit = bitcoin ? 'USD' : 'US$ millions';
  const expectedLicense = bitcoin ? LICENSE_URL : 'CC-BY-4.0';
  if (!Array.isArray(rows) || !rows.length || data.units !== expectedUnit || data.license !== expectedLicense) {
    throw new Error('Invalid ETF dataset');
  }
  const source = SOURCES[asset];
  const declaredFunds = bitcoin ? [] : data.funds;
  if (!Array.isArray(declaredFunds) || (!bitcoin && (!declaredFunds.length || new Set(declaredFunds).size !== declaredFunds.length))) {
    throw new Error('Invalid ETF fund list');
  }
  const fundSymbols = new Set(declaredFunds);
  const multiplier = bitcoin ? 1 : 1_000_000;
  const dates = new Set();
  const asOf = new Date(receivedAt).getTime();
  const reported = rows.map(row => {
    const flows = bitcoin ? row?.perEtfUsd : row?.funds;
    if (!tradingDate(row?.date, asOf) || dates.has(row.date)
      || (!record(flows) && flows !== null && flows !== undefined)) {
      throw new Error('Invalid ETF daily row');
    }
    dates.add(row.date);
    const total = bitcoin ? row.netFlowUsd : row.total;
    if (total === undefined) throw new Error('Missing ETF daily total');
    const funds = {};
    for (const [symbol, value] of Object.entries(flows ?? {})) {
      if (!ticker.test(symbol) || (!bitcoin && !fundSymbols.has(symbol))) throw new Error('Invalid ETF fund symbol');
      fundSymbols.add(symbol);
      funds[symbol] = usd(value, multiplier);
    }
    return {date:row.date, totalUsd:usd(total, multiplier), funds};
  }).sort((a, b) => a.date.localeCompare(b.date));
  const funds = [...fundSymbols].sort();
  if (!funds.every(symbol => typeof symbol === 'string' && ticker.test(symbol)) || !reported.some(day => day.totalUsd !== null)) {
    throw new Error('Missing ETF observations');
  }
  const datasetThrough = bitcoin ? data.updatedThrough : data.coverage?.[1];
  if (datasetThrough !== reported.at(-1).date) throw new Error('Invalid ETF coverage date');
  const days = reported.slice(-60).map(day => ({
    ...day,
    funds:Object.fromEntries(funds.map(symbol => [symbol, day.funds[symbol] ?? null]))
  }));
  const latest = days.at(-1);
  return {
    asset,
    unit:'USD',
    source:{...source, unit:expectedUnit, license:'CC BY 4.0', licenseUrl:LICENSE_URL},
    coverage:{
      market:'US spot ETFs',
      from:days[0].date,
      to:latest.date,
      sessions:days.length,
      datasetThrough,
      latestStatus:asOf - Date.parse(latest.date) >= 7 * DAY ? 'historical' : latest.totalUsd === null ? 'pending' : 'reported'
    },
    funds,
    days
  };
}

function decodeCashMatrix(html, receivedAt) {
  // Only the dated matrix is comparable across issuers. The overview can mix reporting dates.
  const section = typeof html === 'string' && html.match(/<section\b[^>]*\bid=["']matrix["'][^>]*>([\s\S]*?)<\/section>/i)?.[1];
  if (!section || !/Daily Flow Matrix/i.test(section) || !/Net flow per fund per day\s*·\s*million USD/i.test(section)) {
    throw Error('Invalid ETH ETF matrix or unit');
  }
  const table = section.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1] ?? '';
  const header = table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1] ?? '';
  const columns = Array.from(header.matchAll(/<th\b[^>]*>([^<>]*)<\/th>/gi), cell => cell[1].trim());
  const funds = columns.slice(1, -1);
  if (columns[0] !== 'Date' || columns.at(-1) !== 'TOTAL' || !funds.length ||
    funds.length > 80 || !funds.includes('ETHA') || new Set(funds).size !== funds.length || !funds.every(symbol => ticker.test(symbol))) {
    throw Error('Invalid ETH ETF matrix columns');
  }
  const body = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? '';
  const dates = new Set();
  const rows = Array.from(body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), row => {
    const cells = Array.from(row[1].matchAll(/<td\b[^>]*>([^<>]*)<\/td>/gi), cell => cell[1].trim());
    const date = cells[0];
    if (cells.length !== columns.length || !tradingDate(date, receivedAt) || dates.has(date)) throw Error('Invalid ETH ETF matrix row');
    dates.add(date);
    return {date, cells};
  }).sort((a,b) => a.date.localeCompare(b.date)).slice(-10);
  if (!rows.length) throw Error('Missing ETH ETF cash flows');
  function matrixAmount(value) {
    if (/^(?:|—|–|-|&mdash;|N\/A|Pending)$/i.test(value)) return null;
    if (!/^[+-]?\d+(?:\.\d)?$/.test(value)) throw Error('Invalid ETH ETF cash amount');
    return usd(Number(value), 1_000_000);
  }
  const days = rows.map(({date, cells}) => ({
    date, totalUsd:matrixAmount(cells.at(-1)),
    funds:Object.fromEntries(funds.map((symbol,i) => [symbol, matrixAmount(cells[i+1])]))
  }));
  for (const day of days) {
    const amounts=Object.values(day.funds);
    if (day.totalUsd === null || amounts.includes(null)) continue;
    const summed=amounts.reduce((sum, value) => sum + value, 0);
    const tolerance=(amounts.length+1)*ETH_CASH_SOURCE.precisionUsd/2;
    if (Math.abs(summed-day.totalUsd)>tolerance) throw Error('Inconsistent ETH ETF matrix total');
  }
  const latest = days.at(-1);
  return {
    asset:'eth', unit:'USD', source:{...ETH_CASH_SOURCE}, funds, days,
    coverage:{market:'US spot ETFs',from:days[0].date,to:latest.date,sessions:days.length,datasetThrough:latest.date,
      latestStatus:cashStatus(latest,receivedAt)}
  };
}

function fundCashDays(html, fund, matrix, now) {
  const latest=matrix.days.at(-1).date;
  const recent=new Map(matrix.days.map(day=>[day.date,day.funds[fund]]));
  const section=typeof html==='string'&&html.match(/<section\b[^>]*\bid=["']flows["'][^>]*>([\s\S]*?)<\/section>/i)?.[1];
  if (!section || !html.includes('href="https://coinclass.com/etf/fund/'+fund+'"') ||
      !section.replaceAll('<!-- -->','').includes(fund+' Daily Net Flow') ||
      !section.includes('redemptions below · million USD')) return null;
  const titles=Array.from(section.matchAll(/<title>([^<>]*)<\/title>/gi),match=>match[1]);
  if (!titles.length || titles.length>60) return null;
  const history=new Map();
  let matched=false, last='';
  for (const title of titles) {
    const entry=/^([A-Z][a-z]{2}) (\d{1,2}): ([+-])\$(\d+(?:\.\d)?)M net flow$/.exec(title);
    if (!entry) return null;
    const [,month,day,sign,amount]=entry;
    const md=String(MONTHS.indexOf(month)+1).padStart(2,'0')+'-'+day.padStart(2,'0');
    // Chart tooltips omit the year. Anchor their sequence to dated and value-matched matrix observations.
    const date=(Number(latest.slice(0,4))-(md>latest.slice(5)?1:0))+'-'+md;
    const value=usd(Number(sign+amount),1_000_000);
    if (!tradingDate(date,now) || date<=last || Date.parse(latest)-Date.parse(date)>150*DAY) return null;
    if (recent.has(date) && recent.get(date)!==null) {
      if (recent.get(date)!==value) return null;
      matched=true;
    }
    history.set(date,value); last=date;
  }
  return matched?history:null;
}

function decodeFundCash(matrix, fundHtml, fund, now, url=fundPage(fund)) {
  if (!matrix.funds.includes(fund)) throw Error('Unreported ETH ETF fund');
  const fundDays=fundCashDays(fundHtml,fund,matrix,now);
  const history=new Map(fundDays??[]);
  for (const day of matrix.days) history.set(day.date,day.funds[fund]);
  const days=Array.from(history,([date,value])=>({date,totalUsd:null,funds:{[fund]:value}}))
    .sort((a,b)=>a.date.localeCompare(b.date));
  return {...matrix,funds:[fund],days,
    source:{...ETH_CASH_SOURCE,fundUrl:fundDays?url:null},
    coverage:{...matrix.coverage,from:days[0].date,sessions:days.length,
      latestStatus:cashStatus(days.at(-1),now,fund)}};
}

function cashStatus(last, time, fund) {
  if (time - Date.parse(last.date) >= 7 * DAY) return 'historical';
  if (fund) return last.funds[fund]===null?'pending':'reported';
  return last.totalUsd === null || Object.values(last.funds).some(value => value === null) ? 'pending' : 'reported';
}

export function publicEtfRequest(params) {
  if ([...params.keys()].some(key => key !== 'asset' && key !== 'series' && key !== 'fund') || params.getAll('asset').length !== 1) return null;
  const asset = params.get('asset')?.toLowerCase();
  if (asset !== 'btc' && asset !== 'eth') return null;
  const archive = params.has('series');
  if (archive && (asset !== 'eth' || params.getAll('series').length !== 1 || params.get('series') !== 'archive')) return null;
  const fund=params.get('fund');
  if (params.has('fund') && (asset!=='eth' || archive || params.getAll('fund').length!==1 || !ETH_FLOW_FUNDS.includes(fund))) return null;
  if (asset === 'eth' && !archive) return {
    key:fund?'etf:eth:cash:'+fund:'etf:eth:cash', resource:'etf',
    policy:{url:ETH_CASH_SOURCE.dataUrl,headers:{Accept:'text/html'},format:'text',interval:60*60_000,stale:DAY,maxBytes:500_000,
      cacheKey:fund?'etf-eth-coinclass-cash-v3:'+fund:'etf-eth-coinclass-cash-v2'},
    ...(fund?{async collect(load,now) {
      const readFund=url=>load({url,optional:true,timeoutMs:3000});
      const [html,fundHtml]=await Promise.all([load(ETH_CASH_SOURCE.dataUrl),readFund(fundPage(fund))]);
      const matrix=decodeCashMatrix(html,now());
      const primary=decodeFundCash(matrix,fundHtml,fund,now());
      if(primary.source.fundUrl)return primary;
      const canonical=fundPage(fund,true);
      return decodeFundCash(matrix,await readFund(canonical),fund,now(),canonical);
    }}:{}),
    decode:([html,fundHtml], receivedAt) => {
      const matrix=decodeCashMatrix(html,receivedAt);
      return fund?decodeFundCash(matrix,fundHtml,fund,receivedAt):matrix;
    }
  };
  return {
    key:archive?'etf:eth:archive':`etf:${asset}`,
    resource:'etf',
    policy:{url:SOURCES[asset].dataUrl, interval:60 * 60_000, stale:DAY, maxBytes:750_000, format:'json'},
    decode:([data], receivedAt) => decodeEtf(asset, data, receivedAt)
  };
}

export function validatePublicEtf(body, asset, receivedAt, series, fund) {
  const currentCash = asset === 'eth' && series !== 'archive';
  const source = currentCash ? ETH_CASH_SOURCE : SOURCES[asset];
  if (!source || body?.asset !== asset || body.unit !== 'USD' ||
    Object.keys(source).some(key => body.source?.[key] !== source[key])) return false;
  if (!currentCash && (body.source.license !== 'CC BY 4.0' || body.source.licenseUrl !== LICENSE_URL ||
    body.source.unit !== (asset === 'btc' ? 'USD' : 'US$ millions'))) return false;
  const {funds, days, coverage} = body;
  const amount = value => value === null || Number.isFinite(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER;
  if (!Array.isArray(funds) || funds.length < 1 || funds.length > 80 ||
    !funds.every(symbol => typeof symbol === 'string' && ticker.test(symbol)) || new Set(funds).size !== funds.length ||
    !Array.isArray(days) || days.length < 1 || days.length > (currentCash ? (fund?70:10) : 60) || !coverage) return false;
  if (fund && (!currentCash || !ETH_FLOW_FUNDS.includes(fund) || funds.length!==1 || funds[0]!==fund ||
      (![fundPage(fund),fundPage(fund,true)].includes(body.source.fundUrl) && !(body.source.fundUrl===null && days.length<=10)))) return false;
  if (!fund && Object.hasOwn(body.source,'fundUrl')) return false;
  if (!days.every((row, index) => row && tradingDate(row.date, receivedAt) &&
    (index === 0 || row.date > days[index-1].date) && amount(row.totalUsd) && (!fund || row.totalUsd===null) &&
    record(row.funds) && Object.keys(row.funds).length === funds.length && funds.every(symbol => amount(row.funds[symbol])))) return false;
  const last = days.at(-1);
  const status = currentCash ? cashStatus(last, receivedAt,fund) : receivedAt - Date.parse(last.date) >= 7 * DAY ? 'historical' : last.totalUsd === null ? 'pending' : 'reported';
  return coverage.market === 'US spot ETFs' && coverage.from === days[0].date && coverage.to === last.date &&
    coverage.datasetThrough === last.date && coverage.sessions === days.length && coverage.latestStatus === status;
}
