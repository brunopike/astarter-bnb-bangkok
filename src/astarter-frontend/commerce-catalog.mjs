// P0.6.1: designed cost fixtures, not observed provider bills. Real payments and calls stay disabled.
export const VERSION="P0.6.1", DAY=86400000, REAL_PAYMENTS=false;
export const PLANS={
  "free": {
    "price_usd": "0",
    "period_days": null,
    "included_credits": 0,
    "welcome_credits": 600,
    "welcome_days": 14,
    "factor": "1.00",
    "seats": 1,
    "parallel_jobs": 1,
    "daily_dispatched_jobs": 5,
    "tracked_assets": 10,
    "saved_strategies": 2,
    "observed_addresses": 1,
    "running_instances": 0,
    "auto_research": false,
    "default_auto_daily": 0,
    "default_auto_single": 0,
    "address_observation_mode": "saved_address_and_on_demand_existing_data_no_background_scan",
    "id": "free",
    "name": "Free",
    "rate": 100,
    "priceCents": 0
  },
  "starter": {
    "price_usd": "9",
    "period_days": 30,
    "included_credits": 3000,
    "factor": "0.95",
    "seats": 1,
    "parallel_jobs": 1,
    "daily_dispatched_jobs": 60,
    "tracked_assets": 30,
    "saved_strategies": 10,
    "observed_addresses": 3,
    "running_instances": 1,
    "auto_research": true,
    "default_auto_daily": 100,
    "default_auto_single": 100,
    "continuous_monitoring_scope": "Only verified licensed shared-feed coverage; no dedicated paid streams or per-address high-frequency polling included",
    "id": "starter",
    "name": "Starter",
    "rate": 95,
    "priceCents": 900
  },
  "pro": {
    "price_usd": "29",
    "period_days": 30,
    "included_credits": 12000,
    "factor": "0.90",
    "seats": 1,
    "parallel_jobs": 3,
    "daily_dispatched_jobs": 200,
    "tracked_assets": 100,
    "saved_strategies": 50,
    "observed_addresses": 10,
    "running_instances": 3,
    "auto_research": true,
    "default_auto_daily": 400,
    "default_auto_single": 350,
    "continuous_monitoring_scope": "Only verified licensed shared-feed coverage; no dedicated paid streams or per-address high-frequency polling included",
    "id": "pro",
    "name": "Pro",
    "rate": 90,
    "priceCents": 2900
  },
  "team": {
    "price_usd": "99",
    "period_days": 30,
    "included_credits": 45000,
    "factor": "0.85",
    "seats": 5,
    "parallel_jobs": 5,
    "daily_dispatched_jobs": 500,
    "tracked_assets": 300,
    "saved_strategies": 200,
    "observed_addresses": 50,
    "running_instances": 10,
    "auto_research": true,
    "default_auto_daily": 1500,
    "default_auto_single": 600,
    "billing_scope": "one_workspace_not_per_seat",
    "continuous_monitoring_scope": "Only verified licensed shared-feed coverage; no dedicated paid streams or per-address high-frequency polling included",
    "id": "team",
    "name": "Team",
    "rate": 85,
    "priceCents": 9900
  }
};
export const BILLING_INTERVALS={monthly:{months:1,percent:100},quarterly:{months:3,percent:90},yearly:{months:12,percent:70}};
export function subscriptionPrice(product,interval='monthly'){
 const plan=Object.hasOwn(PLANS,product)?PLANS[product]:null,term=Object.hasOwn(BILLING_INTERVALS,interval)?BILLING_INTERVALS[interval]:null;
 if(!plan||product==='free')throw Object.assign(Error('invalid-product'),{status:400});
 if(!term)throw Object.assign(Error('billing-interval'),{status:400});
 const baseCents=plan.priceCents*term.months,cents=Math.round(baseCents*term.percent/100);
 return {interval,months:term.months,baseCents,discountCents:baseCents-cents,cents,credits:plan.included_credits};
}
// Anchor every renewal to the original day in UTC+8, including short months.
export function addBillingMonths(time,months){
 const d=new Date(time+8*3600000),last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+months+1,0)).getUTCDate();
 return Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+months,Math.min(d.getUTCDate(),last),d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds(),d.getUTCMilliseconds())-8*3600000;
}
export function subscriptionPeriods(order){
 const term=BILLING_INTERVALS[order.billing_interval];
 if(!term)return [{index:0,from:order.start_at,until:order.end_at??order.start_at+30*DAY}];
 return Array.from({length:term.months},(_,index)=>({index,from:addBillingMonths(order.start_at,index),until:addBillingMonths(order.start_at,index+1)}));
}
export const PROFILES={
  "Q1": {
    "id": "Q1",
    "zh": "已有材料问答或追问",
    "en": "Context Q&A",
    "scope": {
      "question_count": 1,
      "evidence": "existing_qualified_context"
    },
    "automatic": false,
    "calls": 1,
    "normal": [
      540000000,
      0
    ],
    "high": [
      1296000000,
      0
    ],
    "bound": [
      1603800000,
      0
    ]
  },
  "Q2": {
    "id": "Q2",
    "zh": "补充证据的交易问答",
    "en": "Evidence Q&A",
    "scope": {
      "question_count": 1,
      "evidence": "bounded_incremental_query"
    },
    "automatic": false,
    "calls": 2,
    "normal": [
      4460400000,
      2000000000
    ],
    "high": [
      8964000000,
      8000000000
    ],
    "bound": [
      10038600000,
      8800000000
    ]
  },
  "M1": {
    "id": "M1",
    "zh": "解读行情",
    "en": "Market analysis",
    "scope": {
      "assets": 1,
      "bar_intervals": 1,
      "max_bars": 1000
    },
    "automatic": false,
    "calls": 3,
    "normal": [
      33210000000,
      4000000000
    ],
    "high": [
      64260000000,
      10000000000
    ],
    "bound": [
      76804200000,
      11000000000
    ]
  },
  "R1": {
    "id": "R1",
    "zh": "投研简报",
    "en": "Research brief",
    "scope": {
      "assets": 1,
      "sector_count": 1,
      "scope_choice": "asset_or_sector",
      "default_days": 7,
      "max_days": 7,
      "max_sector_sample_assets": 3
    },
    "automatic": false,
    "calls": 2,
    "normal": [
      30564000000,
      4000000000
    ],
    "high": [
      56808000000,
      10000000000
    ],
    "bound": [
      67240800000,
      11000000000
    ]
  },
  "R2": {
    "id": "R2",
    "zh": "标准投研报告",
    "en": "Research report",
    "scope": {
      "assets": 3,
      "sector_count": 1,
      "max_sector_sample_assets": 5,
      "scope_choice": "assets_or_sector",
      "default_days": 30,
      "max_days": 90
    },
    "automatic": false,
    "calls": 5,
    "normal": [
      137332800000,
      16000000000
    ],
    "high": [
      274665600000,
      40000000000
    ],
    "bound": [
      328505760000,
      44000000000
    ]
  },
  "R3": {
    "id": "R3",
    "zh": "深度投研报告",
    "en": "Deep research",
    "scope": {
      "assets": 5,
      "sector_count": 3,
      "max_sector_sample_assets_total": 10,
      "scope_choice": "assets_or_sectors",
      "max_days": 180
    },
    "automatic": false,
    "calls": 8,
    "normal": [
      345060000000,
      60000000000
    ],
    "high": [
      690120000000,
      120000000000
    ],
    "bound": [
      826135200000,
      132000000000
    ]
  },
  "S1": {
    "id": "S1",
    "zh": "AI策略草稿或实质修改",
    "en": "Strategy draft",
    "scope": {
      "assets": 1,
      "strategy_configs": 1,
      "grants_execution_authority": false
    },
    "automatic": false,
    "calls": 3,
    "normal": [
      86184000000,
      4000000000
    ],
    "high": [
      172368000000,
      12000000000
    ],
    "bound": [
      208612800000,
      13200000000
    ]
  },
  "S2": {
    "id": "S2",
    "zh": "执行方案完整研究或评审",
    "en": "Strategy review",
    "scope": {
      "bounded_plans": 1,
      "required_roles": "strategy_specific_not_relaxed_by_pricing",
      "grants_execution_authority": false
    },
    "automatic": false,
    "calls": 9,
    "normal": [
      171828000000,
      8000000000
    ],
    "high": [
      343656000000,
      20000000000
    ],
    "bound": [
      416572200000,
      22000000000
    ]
  },
  "P1": {
    "id": "P1",
    "zh": "持仓解读",
    "en": "Portfolio analysis",
    "scope": {
      "accounts": 1,
      "max_positions": 10
    },
    "automatic": false,
    "calls": 3,
    "normal": [
      98884800000,
      4000000000
    ],
    "high": [
      197769600000,
      12000000000
    ],
    "bound": [
      241306560000,
      13200000000
    ]
  },
  "J1": {
    "id": "J1",
    "zh": "交易复盘",
    "en": "Trade review",
    "scope": {
      "runs": 1,
      "max_fills": 100
    },
    "automatic": false,
    "calls": 4,
    "normal": [
      111672000000,
      4000000000
    ],
    "high": [
      223344000000,
      12000000000
    ],
    "bound": [
      269438400000,
      13200000000
    ]
  },
  "A1": {
    "id": "A1",
    "zh": "定时简报",
    "en": "Scheduled brief",
    "scope": {
      "new_research_included": false,
      "evidence": "existing_research"
    },
    "automatic": true,
    "calls": 1,
    "normal": [
      2332800000,
      0
    ],
    "high": [
      5184000000,
      0
    ],
    "bound": [
      5702400000,
      0
    ]
  },
  "A2": {
    "id": "A2",
    "zh": "追踪事件轻量分析",
    "en": "Event analysis",
    "scope": {
      "deduplicated_events": 1,
      "complex_event_requires_new_quote": true
    },
    "automatic": true,
    "calls": 1,
    "normal": [
      2916000000,
      1000000000
    ],
    "high": [
      7128000000,
      4000000000
    ],
    "bound": [
      7840800000,
      4400000000
    ]
  }
};
export const currentPlan=s=>PLANS[s.plan]||PLANS.free;
export function credits(parts,rate=100,payers={model:'official',data:'official'}){
 const cost=BigInt(payers.model==='own'?0:parts[0])+BigInt(payers.data==='own'?0:parts[1]);
 const n=cost*2600n*BigInt(rate),d=100000000000000n;
 return Number((n+d-1n)/d);
}
export function estimate(profile,plan='free',payers){
 const p=PROFILES[profile];if(!p)throw Error('profile');
 const rate=PLANS[plan]?.rate??100;
 return {normal:credits(p.normal,rate,payers),high:credits(p.high,rate,payers),max:credits(p.bound,rate,payers)};
}
export const FREE_ACTIONS=['browse','existing-result','download','share-preview','rule-check','approve','cancel','exit','protection'];

export function visibleTurn(turn,status){
 if(!turn.billingJob||status==='complete')return turn;
 return {...turn,report:null,technical:null,marketContext:null,billingStatus:status||'pending'};
}
