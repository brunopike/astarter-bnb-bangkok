"""Refresh the official publisher and on-chain round histories independently."""
import argparse
import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import sys
import brain_tradfi
from brain_market_summary import attach_market_provenance, summarize
import brain_tradfi_holdings
import brain_tradfi_oracles
import brain_tradfi_daily
import brain_tradfi_energy
import brain_tradfi_futures
import brain_tradfi_settlements
import brain_tradfi_stocks_tw
import brain_tradfi_mandi_live
import brain_tradfi_mandi_recent
import brain_tradfi_midas
import brain_tradfi_tw
import brain_tradfi_trades
from brain_tradfi_us import issuer_series


def update_issuers(dest,until):
    path=dest/'catalog.json'
    catalog={s['id']:s for s in json.loads(path.read_bytes())['series']} if path.exists() else {}
    available,errors=issuer_series(until)
    for key,(rows,meta) in available.items():
        if rows[0][0][:4]!='2016' or rows!=sorted(rows) or rows[-1][0]>str(until):
            errors[key]='Incomplete or unordered filing history'
            continue
        data_path=dest/(key+'.json')
        old={r[0]:r for r in json.loads(data_path.read_bytes())['rows']} if data_path.exists() else {}
        old.update({r[0]:r for r in rows})
        combined=sorted(old.values())
        brain_tradfi.save(data_path,{'id':key,'rows':combined})
        catalog[key]={**meta,'start':combined[0][0],'end':combined[-1][0],'count':len(combined),
                      'sha256':hashlib.sha256(data_path.read_bytes()).hexdigest()}
    if available:
        brain_tradfi.save(path,{'version':1,'series':list(catalog.values())})
    if errors:
        raise RuntimeError(str(errors))

if __name__ == '__main__':
    now=datetime.now(timezone.utc)
    last_day=now.date()-timedelta(days=1)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]/'brain-evidence'/'tradfi')
    parser.add_argument('--until',type=date.fromisoformat)
    args=parser.parse_args()
    if args.until is not None and args.until>last_day:
        parser.error('Choose a completed UTC day')
    errors=[]
    updaters=(brain_tradfi.build,brain_tradfi_tw.build,update_issuers,brain_tradfi_holdings.build,
              brain_tradfi_trades.build,brain_tradfi_daily.build,brain_tradfi_futures.build,
              brain_tradfi_stocks_tw.build,brain_tradfi_settlements.build,brain_tradfi_energy.build,
              brain_tradfi_energy.build_gas,brain_tradfi_energy.build_gold,
              brain_tradfi_mandi_live.build,brain_tradfi_mandi_recent.build,brain_tradfi_midas.build,brain_tradfi_oracles.build)
    local_sources={brain_tradfi_tw.build:'Asia/Taipei',brain_tradfi_futures.build:'Asia/Taipei',brain_tradfi_stocks_tw.build:'Asia/Taipei',
                   brain_tradfi_energy.build_gold:'Asia/Taipei',brain_tradfi_mandi_live.build:'Asia/Kolkata',
                   brain_tradfi_mandi_recent.build:'Asia/Kolkata'}
    for updater in updaters:
        zone=local_sources.get(updater)
        cutoff=args.until or (now.astimezone(ZoneInfo(zone)).date()-timedelta(days=1) if zone else last_day)
        print(f'Refreshing {updater.__module__}.{updater.__name__} through {cutoff}',flush=True)
        try:
            updater(args.root,cutoff)
        except Exception as exc:
            errors.append(f'{updater.__module__}.{updater.__name__}: {exc}')
            print(errors[-1],file=sys.stderr,flush=True)
    catalog_path=args.root/'catalog.json'
    catalog=json.loads(catalog_path.read_bytes())
    attach_market_provenance(args.root,catalog)
    brain_tradfi.save(catalog_path,catalog)
    brain_tradfi.save(args.root/'summary.json',summarize(catalog_path.read_bytes()))
    sys.exit(bool(errors))
