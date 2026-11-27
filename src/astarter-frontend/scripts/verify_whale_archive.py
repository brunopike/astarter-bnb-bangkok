"""Recheck the complete wallet archive and optionally cross-reference official Hyperliquid transaction timestamps."""
import argparse
from datetime import datetime
from decimal import Decimal
import json
from pathlib import Path

import requests
from whale_archive import sha256, write_json
from whale_archive_analysis import db_session


def verify(root, explorer=False):
    report = json.loads((root/'audit.json').read_text())
    sources = json.loads((root/'sources.json').read_text())
    con = db_session()
    con.execute("""CREATE TEMP TABLE prior(address VARCHAR PRIMARY KEY, gross DECIMAL(38,10),
        pnl DECIMAL(38,10),closes BIGINT,days INTEGER)""")
    total = 0
    for row,source in zip(report['rows'], sources['files'],strict=True):
        day = row['date']
        files = [root/folder/(day+'.parquet') for folder in ['raw','trades','wallet-days']]
        raw,trades,wallets = map(str,files)
        if not (source['date']==day and [sha256(f) for f in files]==[source['sha256'],row['tradeSha256'],row['walletDaySha256']]):
            raise ValueError('Manifest mismatch: '+day)
        n,unique,outside = con.execute("""SELECT count(*),count(DISTINCT (timestamp,coin,trade_id)),
           countif(timestamp::DATE<>?::DATE) FROM read_parquet(?)""",[day,trades]).fetchone()
        if not n==unique==row['qualifyingMatches'] or outside:
            raise ValueError('Duplicate trade or date mismatch: '+day)
        mismatches=con.execute("""SELECT count(*) FROM read_parquet(?) d LEFT JOIN prior h USING(address)
           WHERE d.prior_notional<>coalesce(h.gross,0) OR d.prior_net_pnl<>coalesce(h.pnl,0)
           OR d.prior_realized_fills<>coalesce(h.closes,0) OR d.prior_active_days<>coalesce(h.days,0)
           OR d.whale<>coalesce(h.gross>=1000000,false)
           OR d.smart<>coalesce(h.pnl>=10000 AND h.closes>=20 AND h.days>=3,false)""",[wallets]).fetchone()[0]
        wrong=con.execute("""SELECT count(*) FROM read_parquet(?) t
            LEFT JOIN read_parquet(?) w1 ON t.maker=w1.address LEFT JOIN read_parquet(?) w2 ON t.taker=w2.address
            WHERE w1.address IS NULL OR w2.address IS NULL OR t.maker=t.taker
            OR NOT(w1.whale OR w1.smart OR w2.whale OR w2.smart)
            OR t.maker_whale<>w1.whale OR t.maker_smart<>w1.smart OR t.taker_whale<>w2.whale OR t.taker_smart<>w2.smart
            OR t.notional_usdc<>round(t.price*t.size,10)""",[trades,wallets,wallets]).fetchone()[0]
        if mismatches or wrong:
            raise ValueError(f'{day}: {mismatches} incorrect prior-day balances, {wrong} mislabeled matches')
        con.execute("""INSERT INTO prior SELECT address,notional,net_pnl,realized_fills,1 FROM read_parquet(?)
            ON CONFLICT (address) DO UPDATE SET gross=prior.gross+excluded.gross, pnl=prior.pnl+excluded.pnl,
            closes=prior.closes+excluded.closes,days=prior.days+1""",[wallets])
        total+=n
    if total!=report['summary']['count']:
        raise ValueError('Grand total mismatch')
    trade_files = [str(root/'trades'/(s['date']+'.parquet')) for s in sources['files']]
    tids,hashes,notional,buy,sell = con.execute("""SELECT count(DISTINCT trade_id),count(DISTINCT tx_hash),
        sum(notional_usdc),sum(notional_usdc) FILTER (WHERE taker_smart AND taker_side='buy'),
        sum(notional_usdc) FILTER (WHERE taker_smart AND taker_side='sell') FROM read_parquet(?)""", [trade_files]).fetchone()
    flow = report['summary']['smartTakerNotionalUSDC']
    if (notional,buy or 0,sell or 0)!=(Decimal(report['summary']['qualifyingNotionalUSDC']),Decimal(flow['buy']),Decimal(flow['sell'])):
        raise ValueError('Trade volume or smart-money taker sides do not match the compact summary')
    checked = []
    for sample in report['summary']['samples']:
        raw = str(root/'raw'/(sample['date'][:10]+'.parquet'))
        original=con.execute("""SELECT DISTINCT lower(address),crossed,tx_hash
            FROM read_parquet(?) WHERE trade_id=?::UBIGINT AND coin=? AND timestamp=?::TIMESTAMPTZ""",
            [raw,sample['tradeId'],sample['coin'],sample['date']]).fetchall()
        expected={(sample['taker'],True,sample['txHash']),(sample['maker'],False,sample['txHash'])}
        if set(original)!=expected:
            raise ValueError('Source participant or transaction mismatch: '+sample['id'])
    if explorer:
        for sample in report['summary']['samples']:
            res=requests.post('https://rpc.hyperliquid.xyz/explorer',json={'type':'txDetails','hash':sample['txHash']},timeout=30)
            res.raise_for_status()
            body=res.json()
            tx=body.get('tx') or {}
            if body.get('type')!='txDetails' or abs(tx.get('time',0)/1000-datetime.fromisoformat(sample['date']).timestamp())>0.001:
                raise ValueError('Official explorer timestamp mismatch: '+sample['txHash'])
            checked.append(dict(id=sample['id'],hash=sample['txHash'],timestampMs=tx['time'],block=tx.get('block'),sender=tx.get('user')))
    write_json(root/'verification.json',dict(uniqueMatches=total,distinctVenueTradeIds=tids,distinctChainTransactions=hashes,days=len(sources['files']),sourceFilesRehashed=len(sources['files']),
        allWalletBaselinesAndPerTradeLabelsChecked=True,sourceSamplePairsChecked=len(report['summary']['samples']),officialExplorerSamples=checked))
    print('Verified',total,'unique matched trades and all lagged classifications;',len(checked),'official explorer checks.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--explorer',action='store_true')
    args=parser.parse_args()
    verify(args.root,args.explorer)
