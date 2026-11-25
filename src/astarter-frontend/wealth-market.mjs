import {createPublicClient,http,parseAbi} from 'viem';
import {mainnet} from 'viem/chains';
import {formatStrategyUnits} from './wealth-strategies.mjs';

export const WEALTH_RPC='https://ethereum-rpc.publicnode.com';
export const AAVE_POOL='0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
export const RESEARCH_ASSETS=Object.freeze({
 usdc:{address:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',decimals:6},
 usdt:{address:'0xdAC17F958D2ee523a2206206994597C13D831ec7',decimals:6},
 weth:{address:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',decimals:18},
 wbtc:{address:'0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',decimals:8}
});
const abi=parseAbi(['function getReserveData(address asset) view returns ((uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)']);
const erc20=parseAbi(['function balanceOf(address) view returns (uint256)','function decimals() view returns (uint8)']);
export function createWealthMarket({client=createPublicClient({chain:mainnet,transport:http(WEALTH_RPC,{retryCount:0,timeout:10000})}),now=Date.now}={}){
 const cache=new Map(),pending=new Map();
 async function sample(assetId){
  const asset=RESEARCH_ASSETS[assetId];if(!asset)throw Error('SELECTION');
  if(await client.getChainId()!==1)throw Error('WRONG_CHAIN');
  const block=await client.getBlock({blockTag:'latest'}),asOf=Number(block.timestamp)*1000,receivedAt=now();
  if(!block.hash||asOf>receivedAt+30000||receivedAt-asOf>180000)throw Error('MARKET_STALE');
  const values=await client.readContract({address:AAVE_POOL,abi,functionName:'getReserveData',args:[asset.address],blockNumber:block.number});
  const [configuration,,rate,,,,reserveUpdatedAt,,aToken]=values;
  if(rate<0n||rate>100n*10n**27n||!/^0x[0-9a-fA-F]{40}$/.test(aToken)||/^0x0{40}$/i.test(aToken))throw Error('MARKET_INVALID');
  const [liquidity,decimals]=await Promise.all([client.readContract({address:asset.address,abi:erc20,functionName:'balanceOf',args:[aToken],blockNumber:block.number}),client.readContract({address:asset.address,abi:erc20,functionName:'decimals',blockNumber:block.number})]);
  if(decimals!==asset.decimals||liquidity<0n)throw Error('MARKET_INVALID');
  const flags=configuration.data;
  return {id:'aave-1-'+assetId+'-'+block.number,kind:'market',status:'observed',provider:'Aave V3 · Ethereum',assetId,chainId:1,blockNumber:block.number.toString(),blockHash:block.hash,asOf,receivedAt,expiresAt:asOf+300000,reserveUpdatedAt:Number(reserveUpdatedAt)*1000,aprPercent:formatStrategyUnits((rate*100000000n/(10n**27n)).toString(),6,false),aprBps:Number(rate*10000n/(10n**27n)),availableLiquidityUnits:liquidity.toString(),active:!!(flags&(1n<<56n)),frozen:!!(flags&(1n<<57n)),paused:!!(flags&(1n<<60n)),url:'https://etherscan.io/block/'+block.number,contractUrl:'https://etherscan.io/address/'+AAVE_POOL,admission:'research_only'};
 }
 return {async read(assetId,{force=false}={}){
  const old=cache.get(assetId);if(!force&&old&&now()-old.receivedAt<30000&&old.expiresAt>now())return structuredClone(old);
  if(pending.has(assetId))return pending.get(assetId);
  const task=sample(assetId).then(data=>{cache.set(assetId,data);return data;}).catch(error=>({id:'market-unavailable-'+assetId,kind:'market',status:'unavailable',assetId,asOf:null,receivedAt:now(),expiresAt:now()+60000,reason:['WRONG_CHAIN','MARKET_STALE','MARKET_INVALID'].includes(error.message)?error.message:'MARKET_UNAVAILABLE',url:'https://aave.com/docs/aave-v3/smart-contracts/pool'})).finally(()=>pending.delete(assetId));
  pending.set(assetId,task);return task;
 }};
}
