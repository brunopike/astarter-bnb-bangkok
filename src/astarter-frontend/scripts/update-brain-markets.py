"""Refresh the official publisher and on-chain round histories independently."""
import argparse
import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import sys
import brain_tradfi
import brain_tradfi_holdings
import brain_tradfi_oracles
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
    last_day=datetime.now(timezone.utc).date()-timedelta(days=1)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]/'brain-evidence'/'tradfi')
    parser.add_argument('--until',type=date.fromisoformat,default=last_day)
    args=parser.parse_args()
    if args.until>last_day:
        parser.error('Choose a completed UTC day')
    errors=[]
    updaters=(brain_tradfi.build,brain_tradfi_tw.build,update_issuers,brain_tradfi_holdings.build,
              brain_tradfi_trades.build,brain_tradfi_oracles.build)
    for updater in updaters:
        print(f'Refreshing {updater.__module__}.{updater.__name__} through {args.until}',flush=True)
        try:
            updater(args.root,args.until)
        except Exception as exc:
            errors.append(f'{updater.__module__}.{updater.__name__}: {exc}')
            print(errors[-1],file=sys.stderr,flush=True)
    sys.exit(bool(errors))
