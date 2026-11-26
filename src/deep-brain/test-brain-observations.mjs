// Test-only venue transport. The real collector requests and verifies its 91-day
// window and stores immutable response bytes in the test's temporary directory.
import {collectSourceObservations} from './brain-source-observations.mjs';

export function observeTestArchive(archive,{dir,clock,venueAssets=archive.assets}){
  const fetchImpl=async address=>{
    const url=new URL(address);
    const binance=url.origin==='https://data-api.binance.vision';
    const coinbase=url.origin==='https://api.exchange.coinbase.com';
    if(!binance && !coinbase)throw Error('Unexpected test venue');
    const market=binance?url.searchParams.get('symbol'):url.pathname.split('/')[2];
    const asset=venueAssets.find(row=>row.market===market && row.venue===(binance?'Binance Spot':'Coinbase Exchange'));
    if(!asset)return new Response('Market missing',{status:404});
    const first=binance?Number(url.searchParams.get('startTime')):Date.parse(url.searchParams.get('start'));
    const last=binance?Number(url.searchParams.get('endTime')):Date.parse(url.searchParams.get('end'));
    const rows=asset.bars.filter(([t])=>t*1000>=first && t*1000<=last)
      .map(([time,open,high,low,close,volume])=>binance?
        [time*1000,String(open),String(high),String(low),String(close),String(volume),(time+86400)*1000-1]:
        [time,low,high,open,close,volume]);
    return Response.json(binance?rows:rows.reverse());
  };
  return collectSourceObservations(JSON.stringify(archive),{dir,clock,fetchImpl,retryDelayMs:0});
}
