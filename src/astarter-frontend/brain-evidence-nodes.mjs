import {getNodeHistory} from './brain-history.mjs';
import {gainNode,lossNode} from './brain-trader-history.mjs';

const metrics={
  transactions:['交易笔数','Transactions'],totalCoinbaseOutputsSat:['区块奖励总额 (sat)','Block reward (sat)'],
  subsidySat:['协议补贴 (sat)','Subsidy (sat)'],claimedFeesSat:['矿工费用 (sat)','Miner fees (sat)'],
  blobGasUsed:['Blob Gas 用量','Blob gas used'],blocks:['区块数','Blocks']
};
const fields={blockHeight:['区块高度','Block height'],blockHash:['区块哈希','Block hash'],txHash:['交易哈希','Transaction hash'],
  epoch:['Epoch','Epoch'],checkpointSlot:['检查点 Slot','Checkpoint slot'],contractAddress:['合约地址','Contract address'],valueWei:['转账额 (wei)','Transfer (wei)']};
const cache=new WeakMap();
const pair=(z,e)=>[z,e];
const fmt=new Intl.NumberFormat('en-US',{maximumSignificantDigits:9});
const date=v=>new Date(v*1000).toISOString().slice(0,10);
export function evidenceChildren(r){
  if(cache.has(r))return cache.get(r);
  const items=[],push=(label,detail,source=0)=>items.push({label,detail,source});
  if(r.memoryEvidence){
    items.push(...r.memoryEvidence);
  }else if(r.trader){
    const c=r.trader;
    for(const s of c.steps)push(s.label,s.detail,s.source);
    for(const [tid,start,size,px,pnl,fee,crossed] of c.batch?.fills||[]){
      const result=(Number(pnl)>0?'+':'')+fmt.format(pnl)+' USDC';
      const label=size+' '+c.batch.coin+' @ $'+px;
      push(pair(label,label),pair('成交 '+tid+' · 成交前 '+start+' · '+(crossed?'吃单':'挂单')+' · 平仓盈亏 '+result+' · 费用 '+fee+' USDC',
        'Fill '+tid+' · starting size '+start+' · '+(crossed?'taker':'maker')+' · closed P&L '+result+' · fee '+fee+' USDC'));
    }
  }else if(r.samplePrices){
    r.samplePrices.forEach((price,i)=>{
      const index=String(i+1).padStart(3,'0'),value='$'+fmt.format(price);
      push(pair('样本 '+index+' · '+value,'Sample '+index+' · '+value),
        pair('七日价格序列，第 '+(i+1)+' / '+r.samplePrices.length+' 个美元报价。来源未给出该点的独立时间戳。',
          'USD quote '+(i+1)+' of '+r.samplePrices.length+' in the seven-day series. No individual timestamp accompanies this point.'));
    });
  }else if(r.candles){
    for(const [at,o,h,l,c,v] of r.candles){
      const d=date(at)+' UTC',close=fmt.format(c)+' '+r.priceUnit;
      push(pair(d+' · 收 '+close,d+' · close '+close),pair('开 '+fmt.format(o)+' · 高 '+fmt.format(h)+' · 低 '+fmt.format(l)+' · 收 '+close+' · 成交量 '+fmt.format(v)+' '+r.volumeUnit,
        'O '+fmt.format(o)+' · H '+fmt.format(h)+' · L '+fmt.format(l)+' · C '+close+' · volume '+fmt.format(v)+' '+r.volumeUnit));
    }
  }else if(r.tvlPoint){
    const p=r.tvlPoint;
    for(const [ts,v] of [[p.priorAt,p.priorTvlUsd],[p.at,p.tvlUsd]])if(Number.isFinite(ts)&&Number.isFinite(v)){
      const d=date(ts)+' UTC',value='$'+fmt.format(v);push(pair(d,d),pair('全链 TVL '+value,'Network TVL '+value));
    }
  }else{
    for(const [key,label] of Object.entries(fields))if(r[key]!=null)push(label,pair(String(r[key]),String(r[key])));
    for(const [key,value] of Object.entries(r.metrics||{}))if(metrics[key] && typeof value==='number')push(metrics[key],pair(fmt.format(value),fmt.format(value)));
    const data=r.evidence;
    if(Array.isArray(data?.utcDays)&&Array.isArray(data.values))data.utcDays.forEach((d,i)=>{
      if(data.values[i]==null)return;
      const value=String(data.values[i])+' '+(data.unit||'');push(pair(d,d),pair(value,value));
    });
  }
  cache.set(r,items);return items;
}
const primaryNode={decision:3,'decision-review':4,reaction:13,capture:6,network:8,market:2,sample:6,bars:2,review:13,coverage:11,chain:1,research:3};
export function graphEvidence(scope,asOf,network,en){
  const seen=new Set(),points=[],locale=en?1:0;
  for(let node=0;node<=lossNode;node++){
    for(const r of getNodeHistory(scope,node,asOf,network)){
      if(seen.has(r.id))continue;
      seen.add(r.id);
      const parent=r.trader?(r.trader.outcome==='gain'?gainNode:lossNode):r.nodes.includes(primaryNode[r.kind])?primaryNode[r.kind]:node;
      const tag=r.trader?r.trader.actor+' · '+r.trader.amount[locale]:r.eventAt.slice(0,10)+' · '+r.title[locale];
      const caption=r.title[locale];
      const captionGroup=r.trader?r.trader.outcome:r.kind;
      points.push({id:r.id,record:r.id,child:-1,parent,label:tag,caption,captionGroup,relations:r.relations?.map(link=>link.id),context:r.trader?r.title[locale]:Array.isArray(r.source)?r.source[locale]:r.source});
      evidenceChildren(r).forEach((item,i)=>points.push({id:r.id+'@'+i,record:r.id,child:i,parent,label:item.label[locale],context:tag}));
    }
  }
  return points;
}
