const RPC = 'https://ethereum-rpc.publicnode.com';
const DISCLOSURE = 'https://crypto.com/en/company-news/transparency-first', KEY = 'eth-disclosed-balance:cryptocom-20221111';
const STALE = 1800000, TIMEOUT = 12500, WEI = 10n**18n, MAX_UINT = (1n<<256n)-1n;
export const ETH_DISCLOSED_ADDRESSES = Object.freeze([
  '0x72A53cDBBcc1b9efa39c834A540550e23463AAcB', '0x7758e507850da48cd47df1fb5f875c23e3340c50',
  '0xcffad3200574698b78f32232aa9d63eabd290703', '0x6262998Ced04146fA42253a5C0AF90CA02dfd2A3'
]);
export const PUBLIC_ETH_DISCLOSED_SOURCE = Object.freeze({
  url:RPC, provider:'PublicNode', interval:384000, stale:STALE, timeoutMs:TIMEOUT, maxBytes:524288,
  format:'json', cacheKey:KEY+':v1'
});
const hash = value => typeof value==='string' && /^0x[0-9a-f]{64}$/.test(value);
const quantity = value => typeof value==='string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(value);
const uint = value => typeof value==='string' && /^(?:0|[1-9]\d{0,77})$/.test(value) && BigInt(value)<=MAX_UINT;
const check = value => {if(!value)throw Error('INVALID_ETH_DISCLOSED_BALANCE');};
const exact = (value,keys) => value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
const explorer = address => 'https://etherscan.io/address/'+address;
const eth = wei => {const frac=String(wei%WEI).padStart(18,'0').replace(/0+$/,'');return String(wei/WEI)+(frac?'.'+frac:'');};
const command = (id,method,params) => ({jsonrpc:'2.0',id,method,params});
const headCall = () => command(1,'eth_getBlockByNumber',['finalized',false]);
const balanceCalls = blockHash => ETH_DISCLOSED_ADDRESSES.map((a,i)=>command(i+1,'eth_getBalance',[a,{blockHash,requireCanonical:true}]));
function post(body, maxBytes) {
  return {url:RPC, method:'POST', format:'json', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), maxBytes};
}
export function isEthDisclosedRpcSpec(spec) {
  try {
    if(spec?.url!==RPC || spec.method!=='POST' || typeof spec.body!=='string' || spec.body.length>2000)return false;
    if(spec.body===JSON.stringify(headCall()))return true;
    const rows=JSON.parse(spec.body), blockHash=rows?.[0]?.params?.[1]?.blockHash;
    return hash(blockHash) && spec.body===JSON.stringify(balanceCalls(blockHash));
  } catch {return false;}
}
function fresh(asOf, at) {
  return Number.isSafeInteger(asOf) && asOf>=1668124800000 && asOf%1000===0
    && Number.isSafeInteger(asOf+STALE) && asOf<=at+1000 && at<asOf+STALE;
}
function rpcResult(row,id) {
  check(row?.jsonrpc==='2.0' && row.id===id && !Object.hasOwn(row,'error') && Object.hasOwn(row,'result'));
  return row.result;
}
export function publicEthDisclosedRequest(params) {
  if(!(params instanceof URLSearchParams) || params.size)return null;
  return {key:KEY,resource:'eth-disclosed-balance',policy:PUBLIC_ETH_DISCLOSED_SOURCE,async collect(load,now){
    const requestStartedAt=now(), header=rpcResult(await load(post(headCall(),524288)),1);
    check(hash(header?.hash) && quantity(header?.number) && quantity(header?.timestamp));
    const blockNumber=Number(BigInt(header.number)), sourceAsOf=Number(BigInt(header.timestamp))*1000;
    check(Number.isSafeInteger(blockNumber) && blockNumber>0 && fresh(sourceAsOf,now()));
    const balances=await load(post(balanceCalls(header.hash),8192));
    check(Array.isArray(balances) && balances.length===ETH_DISCLOSED_ADDRESSES.length);
    const byId=new Map(balances.map(row=>[row?.id,row]));
    let total=0n;
    const rows=ETH_DISCLOSED_ADDRESSES.map((address,i)=>{
      const r=rpcResult(byId.get(i+1),i+1);check(quantity(r));
      const n=BigInt(r);total+=n;
      return {address,wei:String(n),eth:eth(n),explorerUrl:explorer(address)};
    });
    const receivedAt=now();
    const body={schema:'eth-disclosed-balance-v1',metric:'eth-disclosed-balance',symbol:'ETH',unit:'ETH',
      source:'PublicNode',sourceUrl:RPC,disclosureUrl:DISCLOSURE,disclosedOn:'2022-11-11',organization:'Crypto.com',
      scope:'FOUR_HISTORICALLY_DISCLOSED_NATIVE_ETH_ADDRESSES',currentControlVerified:false,network:'Ethereum mainnet',
      blockNumber,blockHash:header.hash,sourceAsOf,receivedAt,requestStartedAt,validUntil:sourceAsOf+STALE,
      rows,totalWei:String(total),totalEth:eth(total)};
    check(validateEthDisclosedBalance(body,receivedAt));return body;
  }};
}
export function validateEthDisclosedBalance(d,now=Date.now()) {
  try {
    if(!exact(d,['schema','metric','symbol','unit','source','sourceUrl','disclosureUrl','disclosedOn','organization','scope',
      'currentControlVerified','network','blockNumber','blockHash','sourceAsOf','receivedAt','requestStartedAt','validUntil','rows','totalWei','totalEth'])
      || d.schema!=='eth-disclosed-balance-v1' || d.metric!=='eth-disclosed-balance' || d.symbol!=='ETH' || d.unit!=='ETH'
      || d.source!=='PublicNode' || d.sourceUrl!==RPC || d.disclosureUrl!==DISCLOSURE || d.disclosedOn!=='2022-11-11'
      || d.organization!=='Crypto.com' || d.scope!=='FOUR_HISTORICALLY_DISCLOSED_NATIVE_ETH_ADDRESSES'
      || d.currentControlVerified!==false || d.network!=='Ethereum mainnet' || !Number.isSafeInteger(d.blockNumber)
      || d.blockNumber<=0 || !hash(d.blockHash) || !Number.isSafeInteger(now) || !Number.isSafeInteger(d.receivedAt)
      || d.receivedAt>now+1000 || !Number.isSafeInteger(d.requestStartedAt) || d.requestStartedAt<=0 || d.requestStartedAt>d.receivedAt
      || d.receivedAt-d.requestStartedAt>TIMEOUT || !fresh(d.sourceAsOf,d.receivedAt) || d.validUntil!==d.sourceAsOf+STALE
      || !Array.isArray(d.rows) || d.rows.length!==ETH_DISCLOSED_ADDRESSES.length || !uint(d.totalWei))return false;
    let total=0n;
    for(const [i,row] of d.rows.entries()) {
      const addr=ETH_DISCLOSED_ADDRESSES[i];
      if(!exact(row,['address','wei','eth','explorerUrl']) || row.address!==addr || row.explorerUrl!==explorer(addr)
        || !uint(row.wei) || eth(BigInt(row.wei))!==row.eth)return false;
      total+=BigInt(row.wei);
    }
    return d.totalWei===String(total) && d.totalEth===eth(total);
  }catch{return false;}
}
export function renderEthDisclosedBalance(d,L=(zh)=>zh,now=Date.now()) {
  if(!validateEthDisclosedBalance(d,now))return '';
  const link=(label,url)=>'<a href="'+url+'" target="_blank" rel="noopener noreferrer">'+label+'</a>';
  const date=new Date(d.sourceAsOf).toISOString().replace('T',' ').replace('.000Z',' UTC');
  const rows=d.rows.map(r=>'<tr><td>'+link(r.address.slice(0,8)+'…'+r.address.slice(-6),r.explorerUrl)+'</td><td>'+r.eth+'</td></tr>').join('');
  return '<section class="dc-section"><h2>'+L('Crypto.com 披露地址的 ETH 余额','ETH balances of Crypto.com’s disclosed addresses')+'</h2>'
    +'<p><strong>'+d.totalEth+' ETH</strong></p><p>'+L('2022-11-11 披露的 4 个地址，仅计以太坊主网原生 ETH。地址当前控制权未经复核。','Four addresses disclosed on Nov 11, 2022. Native ETH on Ethereum mainnet only. Current control is unverified.')+'</p>'
    +'<p>'+L('最终确认区块','Finalized block')+' '+link(String(d.blockNumber),'https://etherscan.io/block/'+d.blockNumber)+' · '+date
    +(now>=d.validUntil?' · '+L('数据已过期','Stale snapshot'):'')+'</p>'
    +'<table><thead><tr><th>'+L('地址','Address')+'</th><th>ETH</th></tr></thead><tbody>'+rows+'</tbody></table>'
    +'<p>'+link(L('Crypto.com 披露原文','Crypto.com disclosure'),DISCLOSURE)+' · '+link('PublicNode','https://ethereum.publicnode.com')+'</p></section>';
}
