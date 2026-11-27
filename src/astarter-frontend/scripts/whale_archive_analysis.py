"""Apply lagged wallet labels and retain each verified, bilateral Hyperliquid match once."""
from datetime import date, timedelta
import json

import duckdb
from whale_archive import sha256, write_json, REPO, REVISION, SOURCE, SUBDIR

BASIS = 'wallet-history-prior-utc-day-v1'
ZERO_HASH = '0x' + '0' * 64
SQL_SIDE = """
CREATE TEMP TABLE sides AS SELECT DISTINCT
    timestamp, coin, trade_id, lower(tx_hash) AS tx_hash, price, size, side,
    crossed, lower(address) AS address, order_id, fee, realized_pnl
FROM read_parquet(?)
WHERE dex='hyperliquid' AND asset_class='perp' AND quote_symbol='USDC' AND fee_token='USDC'
    AND price>0 AND size>0 AND trade_id>0 AND order_id IS NOT NULL
    AND side IN ('buy','sell') AND crossed IS NOT NULL AND fee IS NOT NULL AND realized_pnl IS NOT NULL
    AND regexp_full_match(lower(address),'0x[0-9a-f]{40}')
    AND lower(address)<>'0x'||repeat('0',40)
    AND regexp_full_match(lower(tx_hash),'0x[0-9a-f]{64}') AND lower(tx_hash)<>?
    AND coin IS NOT NULL AND length(coin)>0
"""
SQL_MATCH = """
CREATE TEMP TABLE matches AS
SELECT timestamp,coin,trade_id, first(tx_hash) AS tx_hash, first(price) AS price, first(size) AS size,
    round(first(price)*first(size),10)::DECIMAL(32,10) AS notional_usdc,
    first(side) FILTER (WHERE crossed) AS taker_side,
    first(address) FILTER (WHERE crossed) AS taker, first(address) FILTER (WHERE NOT crossed) AS maker,
    first(realized_pnl) FILTER (WHERE crossed) AS taker_pnl, first(fee) FILTER (WHERE crossed) AS taker_fee,
    first(realized_pnl) FILTER (WHERE NOT crossed) AS maker_pnl, first(fee) FILTER (WHERE NOT crossed) AS maker_fee
FROM sides GROUP BY timestamp,coin,trade_id
HAVING count(*)=2 AND countif(crossed)=1 AND min(side)<>max(side) AND min(address)<>max(address)
    AND min(price)=max(price) AND min(size)=max(size) AND min(tx_hash)=max(tx_hash)
"""
SQL_WALLET = """
CREATE TEMP TABLE activity AS
WITH account_sides AS (
    SELECT taker AS address,notional_usdc,taker_pnl AS pnl,taker_fee AS fee FROM matches
    UNION ALL SELECT maker,notional_usdc,maker_pnl,maker_fee FROM matches
)
SELECT address, count(*) AS fills, sum(notional_usdc) AS notional, sum(pnl-fee) AS net_pnl,
    countif(pnl<>0) AS realized_fills FROM account_sides GROUP BY address
"""
SQL_STATE = """
CREATE TEMP TABLE wallet_day AS
SELECT a.*, coalesce(h.notional,0) AS prior_notional, coalesce(h.net_pnl,0) AS prior_net_pnl,
    coalesce(h.realized_fills,0) AS prior_realized_fills, coalesce(h.active_days,0) AS prior_active_days,
    coalesce(h.notional>=1000000,false) AS whale,
    coalesce(h.active_days>=3 AND h.realized_fills>=20 AND h.net_pnl>=10000,false) AS smart
FROM activity a LEFT JOIN history h USING(address)
"""
SQL_LABELED = """
CREATE TEMP VIEW labeled AS
SELECT m.timestamp,m.coin,m.trade_id,m.tx_hash,m.price,m.size,m.notional_usdc,m.taker_side,m.taker,m.maker,
    t.whale AS taker_whale,t.smart AS taker_smart,k.whale AS maker_whale,k.smart AS maker_smart
FROM matches m JOIN wallet_day t ON t.address=m.taker JOIN wallet_day k ON k.address=m.maker
WHERE t.whale OR t.smart OR k.whale OR k.smart
"""


def db_session():
    con = duckdb.connect(config={'threads': 5, 'memory_limit': '8GB'})
    con.execute("SET TimeZone='UTC'")
    con.execute('SET preserve_insertion_order=false')
    return con


def export(con, query, path):
    path.parent.mkdir(exist_ok=True, parents=True)
    tmp = path.with_suffix('.tmp')
    compressed = " (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 2, ROW_GROUP_SIZE 65536)"
    con.execute('COPY (' + query + ') TO ?' + compressed, [str(tmp)])
    tmp.replace(path)


def localized(english, chinese):
    return dict(en=english, zh=chinese)


def queries(con, paths):
    return con.execute("""SELECT count(*), countif(taker_whale OR maker_whale),
        countif(taker_smart OR maker_smart), countif((taker_whale OR maker_whale) AND (taker_smart OR maker_smart)),
        min(timestamp),max(timestamp),sum(notional_usdc),count(DISTINCT coin)
        FROM read_parquet(?)""",[paths]).fetchone()


def iso(time):
    return time.isoformat(timespec='milliseconds').replace('+00:00','Z')


def analyze(root, summary_path):
    sources = json.loads((root/'sources.json').read_text())
    rows = sources['files']
    if not rows or sources['repository']!=REPO or sources['revision']!=REVISION:
        raise ValueError('Expected pinned Reservoir source manifest')
    dates = [date.fromisoformat(f['date']) for f in rows]
    if dates != [dates[0]+timedelta(days=i) for i in range(len(rows))]:
        raise ValueError('Source dates must be contiguous and unique')
    con = db_session()
    con.execute("""CREATE TEMP TABLE history(address VARCHAR PRIMARY KEY,notional DECIMAL(38,10),
        net_pnl DECIMAL(38,10),realized_fills BIGINT, active_days INTEGER)""")
    trade_files = []
    wallet_files = []
    audit = []
    for f,day in zip(rows,dates):
        raw = root/'raw'/(f['date']+'.parquet')
        if raw.stat().st_size!=f['bytes'] or sha256(raw)!=f['sha256']:
            raise ValueError(f"Source hash mismatch: {f['date']}")
        count,day_min,day_max,zero = con.execute(
            'SELECT count(*),min(timestamp)::DATE,max(timestamp)::DATE,countif(tx_hash=?) FROM read_parquet(?)',
            [ZERO_HASH,str(raw)]).fetchone()
        if not count or day_min!=day or day_max!=day:
            raise ValueError('Rows outside declared UTC day: '+str(day))
        con.execute(SQL_SIDE,[str(raw),ZERO_HASH])
        dedup=con.execute('SELECT count(*) FROM sides').fetchone()[0]
        con.execute(SQL_MATCH)
        pairs=con.execute('SELECT count(*) FROM matches').fetchone()[0]
        con.execute('DROP TABLE sides')
        con.execute(SQL_WALLET)
        con.execute(SQL_STATE)
        con.execute(SQL_LABELED)
        trades=root/'trades'/(str(day)+'.parquet')
        wallets=root/'wallet-days'/(str(day)+'.parquet')
        export(con,'SELECT * FROM labeled ORDER BY timestamp,coin,trade_id',trades)
        export(con,'SELECT * FROM wallet_day ORDER BY address',wallets)
        con.execute("""INSERT INTO history SELECT address,notional,net_pnl,realized_fills,1 FROM activity
            ON CONFLICT (address) DO UPDATE SET notional=history.notional+excluded.notional,
            net_pnl=history.net_pnl+excluded.net_pnl, realized_fills=history.realized_fills+excluded.realized_fills,
            active_days=history.active_days+1""")
        trade_files.append(str(trades));wallet_files.append(str(wallets))
        n = con.execute('SELECT count(*) FROM read_parquet(?)',[str(trades)]).fetchone()[0]
        audit.append(dict(date=str(day),sourceFills=count,zeroHashFills=zero,distinctEligibleSides=dedup,
                          verifiedMatches=pairs,qualifyingMatches=n,tradeSha256=sha256(trades),walletDaySha256=sha256(wallets)))
        write_json(root/'day-audits'/(str(day)+'.json'),audit[-1])
        print(str(day), 'paired',pairs, 'qualified',n,flush=True)
        for obj in ['VIEW labeled','TABLE matches','TABLE activity','TABLE wallet_day']:
            con.execute('DROP '+obj)
    summarize(con,root,summary_path,dates,audit,trade_files,wallet_files)
    con.close()


def summarize(con,root,summary_path,dates,audit,trade_files,wallet_files):
    count,whale,smart,both,start,end,volume,markets=queries(con,trade_files)
    buy,sell=con.execute("""SELECT sum(notional_usdc) FILTER (WHERE taker_side='buy'),
        sum(notional_usdc) FILTER (WHERE taker_side='sell') FROM read_parquet(?) WHERE taker_smart""",
        [trade_files]).fetchone()
    buy=buy or 0
    sell=sell or 0
    flow=buy+sell
    buy_percent=buy/flow*100 if flow else None
    sell_percent=sell/flow*100 if flow else None
    if not count or count!=sum(a['qualifyingMatches'] for a in audit) or count!=whale+smart-both:
        raise ValueError('No qualifying matches or trade counts do not reconcile; verify the warm-up window.')
    whale_wallets,smart_wallets=con.execute("""SELECT
       count(DISTINCT address) FILTER (WHERE whale),count(DISTINCT address) FILTER (WHERE smart)
       FROM read_parquet(?)""",[wallet_files]).fetchone()
    groups=con.execute("""SELECT coin,count(*) AS total,sum(notional_usdc) AS notional FROM read_parquet(?)
      GROUP BY coin ORDER BY total DESC LIMIT 10""",[trade_files]).fetchall()
    samples=[]
    for category, predicate in [('both','(taker_whale OR maker_whale) AND (taker_smart OR maker_smart)'),
                                ('whale','(taker_whale OR maker_whale) AND NOT(taker_smart OR maker_smart)'),
                                ('smart','(taker_smart OR maker_smart) AND NOT(taker_whale OR maker_whale)')]:
        selected=con.execute(f"""SELECT timestamp, coin,trade_id,tx_hash,notional_usdc,taker,maker,
            taker_whale,taker_smart,maker_whale,maker_smart FROM read_parquet(?) WHERE {predicate}
            ORDER BY timestamp DESC,coin,trade_id LIMIT 2""",[trade_files]).fetchall()
        for at,coin,tid,tx,n,taker,maker,tw,ts,mw,ms in selected:
            en,zh={'both':('Whale and smart-money wallets','巨鲸与聪明钱'),
                   'whale':('Whale wallet','巨鲸钱包'),'smart':('Smart-money wallet','聪明钱钱包')}[category]
            samples.append(dict(id=f'{coin}:{iso(at)}:{tid}',date=iso(at),label=localized(f'{coin} · {en}',f'{coin} · {zh}'),
                   value=f'{n:,.2f} USDC', url='https://app.hyperliquid.xyz/explorer/tx/'+tx,
                   coin=coin,tradeId=str(tid),txHash=tx,taker=taker,maker=maker,takerWhale=tw,takerSmart=ts,makerWhale=mw,makerSmart=ms))
    en=(f'Native USDC perpetuals on Hyperliquid, using both sides of verified matched trades. Labels are frozen at the preceding UTC day-end, with history starting {dates[0]}. Whale wallets had at least 1 million USDC of observed notional. Smart-money wallets had at least 10,000 USDC of observed realized P&L after reported fees, 20 non-zero realized fills and three active days. Wallet classifications may include small individual matches. Each match is counted once even when both parties qualify. Funding, other venues and unrealized P&L are excluded.')
    zh=(f'覆盖 Hyperliquid 原生 USDC 永续合约。从 {dates[0]} 起按 UTC 日累计，使用前一日结束时的记录判定。巨鲸为已观察累计名义成交额至少 100 万 USDC 的钱包；聪明钱为已观察扣除成交手续费后的已实现盈亏至少 1 万 USDC、至少 20 笔已实现盈亏非零的成交且至少活跃 3 天的钱包。标签适用于钱包，单笔成交可小于门槛。同一撮合只计一次。盈亏不含资金费、其他场所和未实现浮盈亏。')
    name,top_count,_=groups[0]
    flow_en=(f'Across trades initiated by smart-money wallets, buys totaled {buy:,.2f} USDC ({buy_percent:.1f}%) and sells {sell:,.2f} USDC ({sell_percent:.1f}%).' if flow else 'There were no trades initiated by qualifying smart-money wallets.')
    flow_zh=(f'在聪明钱钱包主动成交中，主动买入 {buy:,.2f} USDC（{buy_percent:.1f}%），主动卖出 {sell:,.2f} USDC（{sell_percent:.1f}%）。占比按主动侧成交额计算。' if flow else '本期尚无符合聪明钱口径的钱包主动成交。')
    summary=dict(count=count,asOf=iso(end),startDate=start.date().isoformat(),endDate=end.date().isoformat(),
        sourceName='Hydromancer · Hyperliquid Reservoir',sourceUrl=SOURCE+'/tree/'+REVISION+'/'+SUBDIR,
        unit=localized('unique matched trades','笔去重撮合成交'),methodology=localized(en,zh),
        analysis=localized(f'The matched notional was {volume:,.2f} USDC. {flow_en} These are taker-side matched amounts. {name} represented {top_count/count:.1%} of qualifying matches.',
                           f'去重成交的名义金额合计 {volume:,.2f} USDC。{flow_zh}{name} 占全部达标撮合笔数的 {top_count/count:.1%}。'),
        stats=[dict(label=localized(x,y),value=v) for x,y,v in [('Whale-involved trades','涉及巨鲸的成交',whale),
            ('Smart-money-involved trades','涉及聪明钱的成交',smart),('Trades meeting both filters','同时符合两类的成交',both),
            ('Whale wallets','达标巨鲸地址',whale_wallets),('Smart-money wallets','达标聪明钱地址',smart_wallets),('Markets','永续合约市场',markets),('Matched notional (USDC)','成交名义金额（USDC）',round(float(volume),2)),('Smart-money taker buys (USDC)','聪明钱主动买入（USDC）',round(float(buy),2)),('Smart-money taker sells (USDC)','聪明钱主动卖出（USDC）',round(float(sell),2))]],
        samples=samples,attribution=dict(name='Hydromancer',url='https://hydromancer.xyz',license='CC BY 4.0',
        licenseUrl='https://creativecommons.org/licenses/by/4.0/',changes='Deduplicated, bilateral matching and lagged wallet classification.'),
        sources=[dict(name='Hydromancer',url='https://hydromancer.xyz'),dict(name='CC BY 4.0',url='https://creativecommons.org/licenses/by/4.0/')],
        smartTakerNotionalUSDC=dict(buy=str(buy),sell=str(sell),total=str(flow),buyShare=str(buy_percent/100) if flow else None,sellShare=str(sell_percent/100) if flow else None),
        historyStart=str(dates[0]),historyEnd=str(dates[-1]),classification=BASIS,
        qualifyingNotionalUSDC=str(volume),topMarkets=[dict(coin=c,matches=n,notionalUSDC=str(v)) for c,n,v in groups])
    if root is not None:
        write_json(root/'audit.json',dict(classification=BASIS,sourceRevision=REVISION,uniqueKey=['timestamp','coin','trade_id'],
        omitted='Zero transaction hashes, non-native/non-USDC, unpaired, ambiguous or non-matching legs and self trades are excluded.',
        excludedAmounts='Funding, other venues and unrealized P&L are not included. Reported trading fees include maker rebates.',
        rows=audit,summary=summary))
    write_json(summary_path,summary)
    print('Summary',count,'matched trades;',whale,'whale;',smart,'smart;',both,'both.',flush=True)
