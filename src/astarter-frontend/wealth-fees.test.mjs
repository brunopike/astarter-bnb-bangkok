import test from 'node:test';
import assert from 'node:assert/strict';
import {DAY_MS,validateTerms,redemptionSchedule,managementAccrual,redemptionFeeQuote,referralSplit,referralStatement,referralAdjustment,quoteLotRedemption,reserveRedemptionCapacity} from './wealth-fees.mjs';
const terms={lockDays:14,maturityDays:180,earlyRedemptionBps:100,settlementDays:2,dayBasis:'calendar',startsAt:'investment-confirmation',maturityAction:'redeem'};
test('lock, maturity and natural T+2 use exact boundaries including weekends',()=>{
 const friday=Date.UTC(2026,10,13,12);
 assert.equal(redemptionSchedule(terms,friday,friday+14*DAY_MS-1).locked,true);
 const unlocked=redemptionSchedule(terms,friday,friday+14*DAY_MS);assert.equal(unlocked.locked,false);assert.equal(unlocked.earlyRedemptionBps,100);
 const mature=redemptionSchedule(terms,friday,friday+180*DAY_MS);assert.equal(mature.earlyRedemptionBps,0);
 assert.equal(new Date(redemptionSchedule({...terms,lockDays:0},friday,friday).settlementAt).getUTCDay(),0);
 for(const change of [{dayBasis:'business'},{settlementDays:0},{maturityDays:14},{lockDays:-1},{earlyRedemptionBps:10001}])assert.throws(()=>validateTerms({...terms,...change}),/TERMS/);
});
test('management accrual is 2% per year with exact 18 decimal values',()=>{
 assert.equal(managementAccrual('100000000000000000000',365*DAY_MS).feeUnits,'2000000000000000000');
 assert.equal(managementAccrual('100000000',DAY_MS).feeUnits,'5479');
 assert.equal(managementAccrual('1',DAY_MS).feeUnits,'0');
 assert.throws(()=>managementAccrual('1000',-1),/FEES/);
 let remainder='0',total=0n;for(let day=0;day<365;day++){const next=managementAccrual('100000000',DAY_MS,remainder);total+=BigInt(next.feeUnits);remainder=next.remainder;}
 assert.equal(total,2000000n);assert.equal(remainder,'0');
});
function quote(overrides={}){return redemptionFeeQuote({grossUnits:'112000000',highWaterValueUnits:'100000000',managementFeeUnits:'2000000',performanceBps:2000,terms,investedAt:0,requestedAt:14*DAY_MS,...overrides});}
test('fees settle management, HWM gains, then early exit without taxing principal as performance',()=>{
 const result=quote();assert.equal(result.performanceFeeUnits,'2000000');assert.equal(result.redemptionFeeUnits,'1080000');assert.equal(result.netUnits,'106920000');assert.equal(result.nextHighWaterValueUnits,'108000000');
 assert.equal(BigInt(result.netUnits)+BigInt(result.managementFeeUnits)+BigInt(result.performanceFeeUnits)+BigInt(result.redemptionFeeUnits),112000000n);
 assert.equal(quote({requestedAt:180*DAY_MS}).redemptionFeeUnits,'0');
 assert.throws(()=>quote({requestedAt:14*DAY_MS-1}),/LOCKED/);
});
test('loss and recovery do not reset or double charge the HWM; redeemed share value is scoped',()=>{
 assert.equal(quote({grossUnits:'95000000'}).performanceFeeUnits,'0');
 assert.equal(quote({grossUnits:'102000000'}).performanceFeeUnits,'0');
 assert.equal(quote({grossUnits:'95000000'}).nextHighWaterValueUnits,'100000000');
 const first=quote();assert.equal(quote({grossUnits:'110000000',highWaterValueUnits:first.nextHighWaterValueUnits}).performanceFeeUnits,'0');
 const partial=quote({grossUnits:'56000000',highWaterValueUnits:'50000000',managementFeeUnits:'1000000'});assert.equal(partial.performanceFeeUnits,'1000000');
 assert.throws(()=>quote({managementFeeUnits:'113000000'}),/FEES/);
});
const receipt={id:'fee-1',assetId:'usdc',investorId:'investor',referrerId:'partner',kind:'management',recipient:'platform',status:'collected',collectedUnits:'100000000',refundedUnits:'10000000'};
test('referral is single level and conserves collected platform fees after refunds',()=>{
 assert.deepEqual(referralSplit(receipt,2000),{id:'fee-1',assetId:'usdc',eligibleUnits:'90000000',referralUnits:'18000000',platformUnits:'72000000'});
 for(const kind of ['principal','unrealised-gain','gas','underlying-fee'])assert.equal(referralSplit({...receipt,kind},2000).referralUnits,'0');
 assert.equal(referralSplit({...receipt,status:'accrued'},2000).referralUnits,'0');
 assert.equal(referralSplit({...receipt,referrerId:'investor'},2000).referralUnits,'0');
 assert.equal(referralSplit({...receipt,kind:'early-redemption',recipient:'vault'},2000).referralUnits,'0');
 assert.equal(referralSplit({...receipt,recipient:'third-party'},2000).referralUnits,'0');
 assert.throws(()=>referralSplit({...receipt,refundedUnits:'100000001'},2000),/REFERRAL/);
});
test('referral receipts are unique, integer exact and never add unlike assets',()=>{
 const eth={...receipt,id:'fee-eth',assetId:'weth',collectedUnits:'1000000000000000001',refundedUnits:'0'};
 const statement=referralStatement([receipt,eth],2000);assert.equal(statement.usdc.referralUnits,'18000000');assert.equal(statement.weth.referralUnits,'200000000000000000');
 assert.equal(BigInt(statement.weth.platformUnits)+BigInt(statement.weth.referralUnits),1000000000000000001n);
 assert.throws(()=>referralStatement([receipt,receipt],2000),/REFERRAL/);
});
test('refund after commission payment creates a clawback, not a second payout',()=>{
 assert.equal(referralAdjustment(receipt,2000,'20000000').adjustmentUnits,'-2000000');
 assert.equal(referralAdjustment(receipt,2000,'18000000').adjustmentUnits,'0');
 assert.equal(referralAdjustment({...receipt,refundedUnits:'100000000'},2000,'20000000').adjustmentUnits,'-20000000');
});

test('partial share redemption allocates only its fees and preserves the surviving HWM',()=>{
 const lot={id:'lot-1',sharesUnits:'100000000000000000000',highWaterNavUnits:'1000000',unpaidManagementUnits:'2000000',performanceBps:2000,terms,investedAt:0};
 const original=structuredClone(lot),quote=quoteLotRedemption({lot,redeemSharesUnits:'50000000000000000000',navPerShareUnits:'1120000',requestedAt:14*DAY_MS});
 assert.equal(quote.grossUnits,'56000000');assert.equal(quote.managementFeeUnits,'1000000');assert.equal(quote.performanceFeeUnits,'1000000');assert.equal(quote.netUnits,'53460000');
 assert.equal(quote.remainingLot.sharesUnits,'50000000000000000000');assert.equal(quote.remainingLot.highWaterNavUnits,'1000000');assert.equal(quote.remainingLot.unpaidManagementUnits,'1000000');assert.deepEqual(lot,original);
 assert.throws(()=>quoteLotRedemption({lot,redeemSharesUnits:'100000000000000000001',navPerShareUnits:'1120000',requestedAt:14*DAY_MS}),/SHARES/);
});
test('T+2 capacity reserves the full gross amount and excludes already committed liquidity',()=>{
 assert.deepEqual(reserveRedemptionCapacity({grossUnits:'100000000',liquidUnits:'60000000',confirmedExitUnits:'50000000',reservedUnits:'10000000',requestedAt:0}),{reservedUnits:'110000000',availableUnits:'0',settlementAt:2*DAY_MS});
 assert.throws(()=>reserveRedemptionCapacity({grossUnits:'100000001',liquidUnits:'60000000',confirmedExitUnits:'50000000',reservedUnits:'10000000',requestedAt:0}),/LIQUIDITY/);
});

