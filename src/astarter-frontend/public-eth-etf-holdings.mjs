const DAY = 86_400_000;
const URL = 'https://cryptokeyhole.com/widget/etf-flows.json?asset=ETH';
const SOURCE = Object.freeze({
  name:'CryptoKeyhole',
  url:'https://cryptokeyhole.com/etf-flows/ethereum/',
  license:'CC BY 4.0',
  licenseUrl:'https://creativecommons.org/licenses/by/4.0/'
});

function requireData(valid) {
  if (!valid) throw Error('INVALID_ETH_ETF_HOLDINGS');
}

function validDate(date, now) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(date);
  if (!Number.isFinite(time) || time > now) return false;
  const parsed = new Date(time);
  return parsed.toISOString().slice(0,10) === date && parsed.getUTCDay() > 0 && parsed.getUTCDay() < 6;
}

function utcDate(seconds) {
  requireData(Number.isSafeInteger(seconds) && seconds > 0 && seconds % 86400 === 0 && seconds < 253402300800);
  return new Date(seconds*1000).toISOString().slice(0,10);
}

const amount = value => Number.isFinite(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER;
const count = value => Number.isInteger(value) && value > 0 && value <= 100;

function decode(raw, now) {
  requireData(raw?.asset === 'ETH' && raw.credit === SOURCE.name && raw.page === SOURCE.url &&
    raw.licence === SOURCE.licenseUrl && Array.isArray(raw.days) && Array.isArray(raw.movers));
  let partial = null;
  if (raw.open !== null && raw.open !== undefined) {
    requireData(Array.isArray(raw.open) && raw.open.length === 3 && typeof raw.open[2] === 'string');
    const parts = /^(\d{1,3}) of (\d{1,3}) funds? reported$/.exec(raw.open[2]);
    requireData(parts);
    partial = {date:utcDate(raw.open[0]),netUsd:raw.open[1],reported:Number(parts[1]),expected:Number(parts[2])};
  }
  const body = {
    source:{...SOURCE}, asset:'ETH', fundsCovered:raw.funds,
    complete:{date:raw.day,netEth:raw.netFlow,netUsd:raw.netFlowUsd},
    partial,
    history:raw.days.map(point=>{
      requireData(Array.isArray(point) && point.length === 2);
      return {date:utcDate(point[0]),netUsd:point[1]};
    }),
    fundObservations:raw.movers.map(row=>({ticker:row?.ticker,name:row?.name,date:row?.asOf,changeEth:row?.flow}))
  };
  requireData(validateEthEtfHoldings(body, now));
  return body;
}

export function validateEthEtfHoldings(body, now) {
  if (body?.asset !== 'ETH' || !count(body.fundsCovered) ||
    !Object.entries(SOURCE).every(([key,value]) => body.source?.[key] === value)) return false;
  const {complete,partial,history,fundObservations} = body;
  if (!validDate(complete?.date,now) || !amount(complete.netEth) || !amount(complete.netUsd)) return false;
  if (!Array.isArray(history) || history.length < 1 || history.length > 32 ||
    !history.every((row,i)=>validDate(row?.date,now) && amount(row.netUsd) && (!i || row.date > history[i-1].date)) ||
    history.at(-1).date !== complete.date || history.at(-1).netUsd !== complete.netUsd) return false;
  if (partial !== null && (!validDate(partial?.date,now) || partial.date <= complete.date ||
    !amount(partial.netUsd) || !count(partial.expected) || partial.expected > body.fundsCovered ||
    !count(partial.reported) || partial.reported >= partial.expected)) return false;
  return Array.isArray(fundObservations) && fundObservations.length <= body.fundsCovered &&
    fundObservations.length <= 25 && fundObservations.every(row=>typeof row?.ticker === 'string' &&
      /^[A-Z][A-Z0-9]{0,9}$/.test(row.ticker) && typeof row.name === 'string' && row.name.length > 0 &&
      row.name.length <= 160 && !/[\u0000-\u001f<>]/.test(row.name) && validDate(row.date,now) && amount(row.changeEth)) &&
    new Set(fundObservations.map(row=>row.ticker)).size === fundObservations.length;
}

export function publicEthEtfHoldingsRequest(params) {
  if (params.size !== 0) return null;
  return {
    key:'eth-etf-holdings',resource:'eth-etf-holdings',
    policy:{url:URL,interval:60*60_000,stale:7*DAY,maxBytes:36_000,format:'json'},
    decode:([raw],now)=>decode(raw,now)
  };
}
