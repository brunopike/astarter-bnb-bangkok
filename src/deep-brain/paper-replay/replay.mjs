import {createHash, randomUUID} from 'node:crypto';
import {link, mkdir, readFile, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {buildBrainProof} from '../brain-proof-engine.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const bundledMarket = new URL('../brain-evidence/daily-markets.json', import.meta.url);
const idPattern = /^[0-9a-f]{64}$/;

export function selectCase(archive, {asset = archive.assets[0]?.key, days = 90, session} = {}) {
  const report = buildBrainProof(archive, {assetKey:asset, days});
  const decision = session ? report.decisions.find(d => d.barOpenAt.slice(0,10) === session)
    : report.decisions.findLast(d => d.execution.status === 'filled') ?? report.decisions.at(-1);
  if (!decision) throw Error('No decision in the requested UTC session and replay window');
  const {execution:r} = decision;
  const fee = report.assumptions.feeBps / 10000;
  const entryFee = r.amount * fee, exitFee = r.quantity * (r.exitPrice ?? 0) * fee;
  const referenceMove = r.status === 'filled' ? r.quantity * ((r.reason === 'stop_loss' ? r.stopPrice : r.settlementBar[4]) - r.settlementBar[1]) : 0;
  if (Math.abs(referenceMove-r.slippage-entryFee-exitFee-r.netPnl)>1e-8 ||
      Math.abs(r.equityAfter-r.equityBefore-r.netPnl)>1e-8 || r.amount>decision.risk.amount) throw Error('Receipt reconciliation failed');
  return {version:'paper-replay-memory-v1',mode:report.mode,runId:report.runId,asset:report.asset,
    decision,assumptions:report.assumptions,sample:report.summary,selectionMethod:session?'requested_session':'latest_fill_or_latest_session',
    attribution:{referenceMove,slippage:r.slippage,entryFee,exitFee,netPnl:r.netPnl}};
}

export async function readMemory(directory,id) {
  if (!idPattern.test(id)) throw Error('Expected a 64-character memory ID');
  const bytes=await readFile(join(directory,id+'.json'));
  if (sha256(bytes)!==id) throw Error('Memory checksum mismatch');
  return JSON.parse(bytes);
}
export async function writeMemory(directory,record) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const bytes=JSON.stringify(record),id=sha256(bytes),temp=join(directory,randomUUID()+'.tmp');
  await writeFile(temp,bytes,{mode:0o600,flag:'wx',flush:true});
  try {await link(temp,join(directory,id+'.json'));}
  catch(error){if(error.code!=='EEXIST')throw error;}
  finally {await unlink(temp);}
  await readMemory(directory,id);
  return id;
}
