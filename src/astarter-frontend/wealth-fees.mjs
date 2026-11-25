export const DAY_MS=86400000;
const unsigned=value=>typeof value==='string'&&/^(0|[1-9]\d{0,77})$/.test(value)&&BigInt(value)<(1n<<256n);
const time=value=>Number.isSafeInteger(value)&&value>=0;
const bps=value=>Number.isInteger(value)&&value>=0&&value<=10000;
function check(ok,code='FEES'){if(!ok)throw Error(code);}
export function validateTerms(terms,{allowLegacy=false}={}){
 check(terms&&Number.isInteger(terms.lockDays)&&terms.lockDays>=0&&terms.lockDays<=3650&&Number.isInteger(terms.maturityDays)&&terms.maturityDays>terms.lockDays&&terms.maturityDays<=3650&&bps(terms.earlyRedemptionBps)&&terms.settlementDays===2&&terms.dayBasis==='calendar'&&terms.startsAt==='investment-confirmation'&&(terms.maturityAction==='redeem'||allowLegacy&&terms.maturityAction===undefined),'TERMS');return terms;
}
export function redemptionSchedule(terms,investedAt,requestedAt){
 validateTerms(terms);check(time(investedAt)&&time(requestedAt)&&requestedAt>=investedAt,'TIME');
 const unlockAt=investedAt+terms.lockDays*DAY_MS,maturityAt=investedAt+terms.maturityDays*DAY_MS;
 return {unlockAt,maturityAt,locked:requestedAt<unlockAt,early:requestedAt<maturityAt,earlyRedemptionBps:requestedAt<maturityAt?terms.earlyRedemptionBps:0,settlementAt:requestedAt+2*DAY_MS};
}
// Accrue each valued interval once; callers must persist the accrual cursor.
export function managementAccrual(navUnits,elapsedMs,remainder='0'){
 const denominator=10000n*365n*BigInt(DAY_MS);check(unsigned(navUnits)&&Number.isSafeInteger(elapsedMs)&&elapsedMs>=0&&unsigned(remainder)&&BigInt(remainder)<denominator);
 const numerator=BigInt(navUnits)*200n*BigInt(elapsedMs)+BigInt(remainder);return {feeUnits:(numerator/denominator).toString(),remainder:(numerator%denominator).toString()};
}
// Inputs are the authoritative values attributable to redeemed shares, not the whole lot.
export function redemptionFeeQuote({grossUnits,highWaterValueUnits,managementFeeUnits,performanceBps,terms,investedAt,requestedAt}){
 check([grossUnits,highWaterValueUnits,managementFeeUnits].every(unsigned)&&bps(performanceBps));
 const schedule=redemptionSchedule(terms,investedAt,requestedAt);check(!schedule.locked,'LOCKED');
 const gross=BigInt(grossUnits),management=BigInt(managementFeeUnits),hwm=BigInt(highWaterValueUnits);check(management<=gross);
 const afterManagement=gross-management,gain=afterManagement>hwm?afterManagement-hwm:0n,performance=gain*BigInt(performanceBps)/10000n;
 const afterPerformance=afterManagement-performance,exit=afterPerformance*BigInt(schedule.earlyRedemptionBps)/10000n;
 return {...schedule,grossUnits,managementFeeUnits,performanceFeeUnits:performance.toString(),redemptionFeeUnits:exit.toString(),netUnits:(afterPerformance-exit).toString(),nextHighWaterValueUnits:(afterPerformance>hwm?afterPerformance:hwm).toString()};
}
export function referralSplit(receipt,rateBps){
 check(receipt&&typeof receipt.id==='string'&&receipt.id.length>0&&receipt.id.length<=100&&typeof receipt.investorId==='string'&&typeof receipt.referrerId==='string'&&typeof receipt.assetId==='string'&&['platform','vault','third-party'].includes(receipt.recipient)&&['accrued','collected'].includes(receipt.status)&&unsigned(receipt.collectedUnits)&&unsigned(receipt.refundedUnits)&&bps(rateBps),'REFERRAL');
 const collected=BigInt(receipt.collectedUnits),refunded=BigInt(receipt.refundedUnits);check(refunded<=collected,'REFERRAL');
 const eligible=receipt.recipient==='platform'&&receipt.status==='collected'&&receipt.referrerId&&receipt.investorId!==receipt.referrerId&&['management','performance','early-redemption'].includes(receipt.kind)?collected-refunded:0n;
 const rebate=eligible*BigInt(rateBps)/10000n;return {id:receipt.id,assetId:receipt.assetId,eligibleUnits:eligible.toString(),referralUnits:rebate.toString(),platformUnits:(eligible-rebate).toString()};
}
export function referralStatement(receipts,rateBps){
 check(Array.isArray(receipts)&&new Set(receipts.map(row=>row.id)).size===receipts.length,'REFERRAL');
 const assets={};for(const receipt of receipts){const row=referralSplit(receipt,rateBps);assets[row.assetId]??={eligibleUnits:'0',referralUnits:'0',platformUnits:'0'};for(const key of Object.keys(assets[row.assetId]))assets[row.assetId][key]=(BigInt(assets[row.assetId][key])+BigInt(row[key])).toString();}return assets;
}

export function referralAdjustment(receipt,rateBps,paidUnits){
 check(unsigned(paidUnits),'REFERRAL');const split=referralSplit(receipt,rateBps);return {...split,paidUnits,adjustmentUnits:(BigInt(split.referralUnits)-BigInt(paidUnits)).toString()};
}

export function quoteLotRedemption({lot,redeemSharesUnits,navPerShareUnits,requestedAt}){
 check(lot&&[lot.sharesUnits,lot.highWaterNavUnits,lot.unpaidManagementUnits,redeemSharesUnits,navPerShareUnits].every(unsigned)&&BigInt(lot.sharesUnits)>0n&&BigInt(redeemSharesUnits)>0n&&BigInt(redeemSharesUnits)<=BigInt(lot.sharesUnits),'SHARES');
 const shares=BigInt(redeemSharesUnits),total=BigInt(lot.sharesUnits),scale=10n**18n;
 const management=BigInt(lot.unpaidManagementUnits)*shares/total;
 const fees=redemptionFeeQuote({grossUnits:(shares*BigInt(navPerShareUnits)/scale).toString(),highWaterValueUnits:(shares*BigInt(lot.highWaterNavUnits)/scale).toString(),managementFeeUnits:management.toString(),performanceBps:lot.performanceBps,terms:lot.terms,investedAt:lot.investedAt,requestedAt});
 // A partial redemption never crystallises or resets the surviving series' high-water mark.
 return {...fees,redeemSharesUnits,remainingLot:{...lot,sharesUnits:(total-shares).toString(),unpaidManagementUnits:(BigInt(lot.unpaidManagementUnits)-management).toString()}};
}

export function reserveRedemptionCapacity({grossUnits,liquidUnits,confirmedExitUnits,reservedUnits,requestedAt}){
 check([grossUnits,liquidUnits,confirmedExitUnits,reservedUnits].every(unsigned)&&BigInt(grossUnits)>0n&&time(requestedAt),'LIQUIDITY');
 const capacity=BigInt(liquidUnits)+BigInt(confirmedExitUnits)-BigInt(reservedUnits);check(capacity>=BigInt(grossUnits),'LIQUIDITY');
 // Callers must commit the reserve and order atomically; forecasts and new deposits are not capacity.
 return {reservedUnits:(BigInt(reservedUnits)+BigInt(grossUnits)).toString(),availableUnits:(capacity-BigInt(grossUnits)).toString(),settlementAt:requestedAt+2*DAY_MS};
}

