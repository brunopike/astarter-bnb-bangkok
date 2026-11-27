"""Archive issuer-listed EVM Transfer logs; defaults to tokenized gold and treasury products on Ethereum.

Requires Python 3.10+ and requests. From the repository root:
  python3 scripts/archive-rwa-chain.py --start 25850000 --end 26501999 --archive /path/to/archive
Resume with the same arguments. Complete, verified parts are reused. A CSV row holds
the two receipt addresses and raw integer emitted by that contract. Date filters use
the UTC block timestamp. A 10,000-block part always includes its boundary headers in
the adjacent manifest, including when the last matching event occurs earlier.
All timestamps in source block headers are integers in seconds since the Unix epoch.
"""
import argparse
import csv
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import sqlite3
import tempfile
from urllib.parse import urlsplit
import time

import requests

NETWORKS = {
    "eth": (1, "Ethereum mainnet", "ethereum-mainnet", "https://etherscan.io"),
    "bsc": (56, "BNB Smart Chain", "binance-mainnet", "https://bscscan.com"),
}
PREFIX = "eth"
CHAIN_ID, CHAIN_NAME, DATASET, EXPLORER = NETWORKS[PREFIX]
PORTAL = f"https://portal.sqd.dev/datasets/{DATASET}"
PROVIDER = "sqd"
RPC_PROVIDERS = {
    "blockpi": ("eth", "https://ethereum.public.blockpi.network/v1/rpc/public", 2500, "BlockPI"),
}
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO = "0x" + "0" * 40
ASSETS = {
    "0x45804880de22913dafe09f4980848ece6ecbaf78": ("PAXG", 18, "https://github.com/paxosglobal/paxos-gold-contract"),
    "0x68749665ff8d2d112fa859aa293f07a622782f38": ("XAUT", 6, "https://tether.to/en/supported-protocols/"),
    "0x96f6ef951840721adbf46ac996b59e0235cb985c": ("USDY", 18, "https://ondo.finance/usdy"),
    "0x1b19c19393e2d034d8ff31ff34c81252fcbbee92": ("OUSG", 18, "https://docs.ondo.finance/addresses"),
}
COLUMNS = ["block_number", "block_hash", "timestamp_utc_seconds", "transaction_hash", "log_index",
           "contract", "from_address", "to_address", "amount_raw_uint256"]
ROOT = Path(__file__).resolve().parents[1]
WORD = re.compile(r"0x[0-9a-f]{64}")
ADDRESS_TOPIC = re.compile(r"0x0{24}([a-f0-9]{40})")
PART_SIZE = 10000


def utc(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def save(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=path.name + ".",
                                     encoding="utf-8", delete=False) as handle:
        json.dump(obj, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    staged = Path(handle.name)
    staged.chmod(0o644)
    staged.replace(path)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as fd:
        for chunk in iter(lambda: fd.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_page(session, start, end):
    if PROVIDER in RPC_PROVIDERS:
        from rwa_eth_rpc import page
        _, endpoint, limit, _ = RPC_PROVIDERS[PROVIDER]
        return page(session, start, end, ASSETS, TRANSFER, endpoint, limit)
    query = {"type": "evm", "fromBlock": start, "toBlock": end,
             "logs": [{"address": list(ASSETS), "topic0": [TRANSFER]}],
             "fields": {"block": {"number": True, "hash": True, "timestamp": True},
                        "log": {"address": True, "transactionHash": True, "logIndex": True,
                                "topics": True, "data": True}}}
    for attempt in range(7):
        try:
            r = session.post(PORTAL + "/stream", json=query, timeout=(10, 40))
            if r.status_code != 429 and r.status_code < 500:
                r.raise_for_status()
                data = [json.loads(line) for line in r.content.splitlines() if line]
                if not data or data[0]["header"]["number"] != start:
                    raise ValueError(f"Missing starting block {start}: {r.text[:150]}")
                if data[-1]["header"]["number"] > int(r.headers["X-Sqd-Finalized-Head-Number"]):
                    raise ValueError(f"Source returned unfinalized data in {start}–{end}")
                return data
            wait = max(float(r.headers.get("Retry-After", 0)), min(60, 2**attempt))
        except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError,
                requests.exceptions.ContentDecodingError) as e:
            if attempt == 6:
                raise RuntimeError(f"SQD could not read {start}–{end}") from e
            wait = min(60, 2**attempt)
        time.sleep(wait)
    raise RuntimeError(f"SQD rejected {start}–{end}")


def row_for(header, event):
    topics = event["topics"]
    if (len(topics) != 3 or topics[0] != TRANSFER or not WORD.fullmatch(event["data"])
            or event["address"] not in ASSETS or not WORD.fullmatch(event["transactionHash"])):
        raise ValueError("Unexpected Transfer event encoding")
    addresses = [ADDRESS_TOPIC.fullmatch(x) for x in topics[1:]]
    if not all(addresses):
        raise ValueError("Invalid indexed transfer address")
    return [header["number"], header["hash"], header["timestamp"], event["transactionHash"],
            event["logIndex"], event["address"], "0x" + addresses[0][1], "0x" + addresses[1][1],
            str(int(event["data"], 16))]


def collect(archive, first, last):
    path = archive / f"{PREFIX}-{first}-{last}.csv.gz"
    receipt = path.with_suffix(".meta.json")
    if receipt.exists() and path.exists():
        meta = json.loads(receipt.read_text())
        if (meta.get("contracts") == list(ASSETS) and meta.get("chainId", 1) == CHAIN_ID and meta.get("fromBlock") == first
                and meta.get("toBlock") == last and digest(path) == meta["sha256"]):
            return meta
    with tempfile.NamedTemporaryFile(dir=archive, prefix=path.name + ".", suffix=".pending", delete=False) as temp_file:
        temp = Path(temp_file.name)
    count = 0
    cursor = first
    start_header = end_header = None
    previous_ts = None
    with (requests.Session() as session, temp.open("wb") as raw,
          gzip.GzipFile(fileobj=raw, filename="", mode="wb", compresslevel=3, mtime=0) as gz,
          io.TextIOWrapper(gz, encoding="ascii", newline="") as text):
        writer = csv.writer(text, lineterminator="\n")
        writer.writerow(COLUMNS)
        while cursor <= last:
            page = fetch_page(session, cursor, last)
            prior = cursor - 1
            for block in page:
                header = block["header"]
                height, ts = header["number"], header["timestamp"]
                if not prior < height <= last or not WORD.fullmatch(header["hash"]) or (previous_ts is not None and ts < previous_ts):
                    raise ValueError(f"Unexpected block order/header at {height}")
                prior, previous_ts = height, ts
                start_header = start_header or header
                end_header = header
                prev_log = -1
                for event in sorted(block.get("logs", []), key=lambda e: e["logIndex"]):
                    if type(event["logIndex"]) is not int or event["logIndex"] <= prev_log:
                        raise ValueError(f"Duplicate or invalid log index at {height}")
                    prev_log = event["logIndex"]
                    writer.writerow(row_for(header, event))
                    count += 1
            cursor = prior + 1
    if end_header["number"] != last:
        raise ValueError(f"Incomplete part at {last}")
    temp.chmod(0o644)
    temp.replace(path)
    meta = {"file": path.name, "readSource": RPC_PROVIDERS[PROVIDER][1] if PROVIDER in RPC_PROVIDERS else PORTAL, "fromBlock": first, "toBlock": last, "count": count,
            "contracts": list(ASSETS), "chainId": CHAIN_ID, "firstHeader": start_header, "lastHeader": end_header,
            "sha256": digest(path)}
    save(receipt, meta)
    return meta


def kind(sender, recipient):
    return "mint" if sender == ZERO else "burn" if recipient == ZERO else "transfer"


def format_amount(raw, decimals):
    integral, fractional = divmod(int(raw), 10**decimals)
    tail = str(fractional).zfill(decimals).rstrip("0")
    return str(integral) + ("." + tail if tail else "")


def record_sample(row):
    height, block_hash, stamp, tx, log, addr, sender, recipient, raw = row
    symbol, decimals, _ = ASSETS[addr]
    return {"id": f"{CHAIN_ID}:{tx}:{log}", "date": utc(int(stamp)), "label": f"{symbol} · {kind(sender, recipient).title()}",
            "value": f"{format_amount(raw, decimals)} {symbol}", "url": f"{EXPLORER}/tx/{tx}#eventlog",
            "block": int(height), "blockHash": block_hash, "logIndex": int(log), "contract": addr,
            "from": sender, "to": recipient, "amountRaw": raw}


def verified_part(archive, part):
    references = {
        "verification": "https://portal.sqd.dev/datasets/ethereum-mainnet/stream",
        "verification-tenderly": "https://gateway.tenderly.co/public/mainnet",
    }
    matches = []
    for directory, endpoint in references.items():
        proof = archive / directory / (part["file"] + ".json")
        if not proof.exists():
            continue
        evidence = json.loads(proof.read_text())
        if evidence.get("sha256") != part["sha256"]:
            continue
        if (evidence.get("file") != part["file"] or evidence.get("reference") != endpoint
                or evidence.get("verifiedCount") != part["count"] or evidence.get("verified") is False):
            raise ValueError(f"Conflicting independent verification receipt {proof}")
        matches.append(evidence)
    return matches


def build_index(archive, parts, output, offline=False):
    rpc_count = 0
    audits = {}
    for part in parts:
        if part.get("readSource") == RPC_PROVIDERS["blockpi"][1]:
            matches = verified_part(archive, part)
            if not matches:
                if offline:
                    raise ValueError(f"Missing independent RPC log reconciliation {part['file']}")
                from rwa_chain_reconciliation import verify
                matches = [verify(archive, part)]
            rpc_count += part["count"]
            for check in matches:
                bucket = audits.setdefault(check["reference"], {"shards": 0, "count": 0})
                bucket["count"] += check["verifiedCount"]
                bucket["shards"] += 1
    counts, kinds, pairs = Counter(), Counter(), defaultdict(Counter)
    samples = {}
    first = last = None
    previous_key = (-1, -1)
    previous_end = parts[0]["fromBlock"] - 1
    with tempfile.TemporaryDirectory(dir=archive) as temp, sqlite3.connect(Path(temp) / "identities.sqlite") as db:
        db.execute("PRAGMA journal_mode=OFF")
        db.execute("PRAGMA synchronous=OFF")
        db.execute("CREATE TABLE identities (tx BLOB, log INTEGER, PRIMARY KEY(tx,log)) WITHOUT ROWID")
        for part in parts:
            if previous_end + 1 != part["fromBlock"]:
                raise ValueError("Non-contiguous block interval")
            previous_end = part["toBlock"]
            path = archive / part["file"]
            if digest(path) != part["sha256"]:
                raise ValueError(f"Digest mismatch for {path}")
            before = sum(counts.values())
            with gzip.open(path, "rt", encoding="ascii", newline="") as fh:
                reader = csv.reader(fh)
                if next(reader) != COLUMNS:
                    raise ValueError("Invalid CSV schema")
                pending = []
                for row in reader:
                    h, block_hash, ts, tx, log, asset, sender, recipient, raw = row
                    key = (int(h), int(log))
                    if key <= previous_key or not part["fromBlock"] <= key[0] <= part["toBlock"]:
                        raise ValueError("Duplicate/overlapping block and log")
                    previous_key = key
                    pending.append((bytes.fromhex(tx[2:]), key[1]))
                    if len(pending) >= 5000:
                        db.executemany("INSERT INTO identities VALUES (?,?)", pending)
                        pending.clear()
                    sym = ASSETS[asset][0]
                    event_kind = kind(sender, recipient)
                    counts[sym] += 1
                    kinds[event_kind] += 1
                    pairs[sym][event_kind] += 1
                    samples[sym, event_kind] = row
                    first = first or row
                    last = row
                db.executemany("INSERT INTO identities VALUES (?,?)", pending)
            if sum(counts.values()) - before != part["count"]:
                raise ValueError(f"Row count mismatch at {part['file']}")
        count = db.execute("SELECT count(*) FROM identities").fetchone()[0]
    if not first or count != sum(counts.values()):
        raise ValueError("No records or inconsistent total")
    start, end = utc(int(first[2])), utc(int(last[2]))
    sources = sorted({part.get("readSource", PORTAL) for part in parts})
    source_names = {PORTAL: "SQD Portal", **{item[1]: item[3] for item in RPC_PROVIDERS.values()}}
    provider_names = " / ".join(source_names[url] for url in sources)
    manifest = {"sources": sources, "schemaVersion": 1, "chainId": CHAIN_ID, "sourceUrl": PORTAL if PORTAL in sources else sources[0], "eventSignature": TRANSFER,
                "columns": COLUMNS, "eventIdFields": ["chainId", "transaction_hash", "log_index"],
                "fromBlock": parts[0]["fromBlock"], "toBlock": parts[-1]["toBlock"],
                "count": count, "startDate": start[:10], "endDate": end[:10], "shards": parts}
    save(archive / "manifest.json", manifest)
    issue_sources = [{"symbol": sym, "address": addr, "decimals": dec, "issuerUrl": source,
                      "count": counts[sym], "eventsByKind": dict(pairs[sym])}
                     for addr, (sym, dec, source) in ASSETS.items()]
    stats = [{"label": {"en": sym + " events", "zh": sym + " 事件"}, "value": counts[sym]}
             for sym, _, _ in ASSETS.values()]
    unique = {}
    for row in [first, *samples.values(), last]:
        sample = record_sample(row)
        unique[sample["id"]] = sample
    summary = {"schemaVersion": 1, "count": count, "asOf": utc(parts[-1]["lastHeader"]["timestamp"]),
               "startDate": start[:10], "endDate": end[:10], "chainId": CHAIN_ID, "sourceName": f"{CHAIN_NAME} · {provider_names}",
               "sourceUrl": PORTAL if PORTAL in sources else sources[0], "sourceUrls": sources, "unit": "ERC-20 Transfer events",
               "methodology": {
                   "en": f"One {CHAIN_NAME} Transfer log from the listed issuer contracts. Unique by transaction hash and log index. Mint and burn logs are counted once. Zero-value and fee-transfer logs are retained when emitted. A transfer is not evidence of trading, redemption, or off-chain settlement.",
                   "zh": f"逐条统计 {CHAIN_NAME} 上清单列出的官方合约 Transfer 日志，以交易哈希和日志序号去重。铸造和销毁各记一次，保留实际发出的零金额与手续费转移事件。转移数量不代表成交量、实际赎回或链下结算。"},
               "stats": stats, "fromBlock": manifest["fromBlock"], "toBlock": manifest["toBlock"],
               "assetContracts": issue_sources, "byToken": dict(counts), "eventCounts": dict(kinds),
               "independentlyReconciledRpcEvents": rpc_count, "independentChecksBySource": audits,
               "archiveManifestSha256": digest(archive / "manifest.json"),
               "samples": sorted(unique.values(), key=lambda x: (x["block"], x["logIndex"]), reverse=True)}
    save(archive / "summary.json", summary)
    if output.resolve() != (archive / "summary.json").resolve():
        save(output, summary)
    return summary


def configure_network(network, contracts):
    global PREFIX, CHAIN_ID, CHAIN_NAME, DATASET, EXPLORER, PORTAL, ASSETS
    PREFIX = network
    CHAIN_ID, CHAIN_NAME, DATASET, EXPLORER = NETWORKS[network]
    PORTAL = f"https://portal.sqd.dev/datasets/{DATASET}"
    if contracts is not None:
        configured = {}
        for item in json.loads(contracts.read_text()):
            address = item["address"].lower()
            symbol, decimals, issuer = item["symbol"], item["decimals"], item["issuerUrl"]
            if (not re.fullmatch(r"0x[0-9a-f]{40}", address) or address in configured
                    or not isinstance(symbol, str) or not symbol.strip()
                    or type(decimals) is not int or not 0 <= decimals <= 255
                    or urlsplit(issuer).scheme != "https" or not urlsplit(issuer).hostname):
                raise ValueError(f"Invalid or duplicate contract: {address}")
            if symbol in {a[0] for a in configured.values()}:
                raise ValueError(f"Ambiguous symbol: {symbol}")
            configured[address] = (symbol, decimals, issuer)
        if not configured:
            raise ValueError("Empty contract registry")
        ASSETS = configured


def main():
    global PROVIDER
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("sqd", *RPC_PROVIDERS), default="sqd")
    parser.add_argument("--chain", choices=list(NETWORKS), default="eth")
    parser.add_argument("--contracts", type=Path, help="JSON array of {address,symbol,decimals,issuerUrl} for this chain")
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--start", type=int, required=True)
    parser.add_argument("--end", type=int, required=True)
    parser.add_argument("--workers", type=int, choices=range(1, 7), default=3)
    parser.add_argument("--summary", type=Path)
    parser.add_argument("--verify-only", action="store_true",
                        help="Rebuild from complete local shards and saved source reconciliation receipts")
    args = parser.parse_args()
    if args.chain != "eth" and (not args.contracts or not args.summary):
        parser.error("Supply both --contracts and --summary for another chain")
    configure_network(args.chain, args.contracts)
    PROVIDER = args.provider
    if PROVIDER in RPC_PROVIDERS and args.chain != RPC_PROVIDERS[PROVIDER][0]:
        parser.error(f"{PROVIDER} is configured for {RPC_PROVIDERS[PROVIDER][0]} only")
    if args.summary is None:
        args.summary = ROOT / "data/research-archives/rwa-chain.json"
    if not 0 <= args.start <= args.end:
        parser.error("Invalid block range")
    args.archive.mkdir(parents=True, exist_ok=True)
    ranges = [(s, min(args.end, s + PART_SIZE - 1)) for s in range(args.start, args.end + 1, PART_SIZE)]
    if args.verify_only:
        parts = []
        for start, end in ranges:
            meta = json.loads((args.archive / f"{PREFIX}-{start}-{end}.csv.meta.json").read_text())
            if (meta["fromBlock"], meta["toBlock"], meta["contracts"], meta.get("chainId", 1)) != (
                    start, end, list(ASSETS), CHAIN_ID):
                raise ValueError(f"Invalid local receipt {start}..{end}")
            parts.append(meta)
        out = build_index(args.archive, parts, args.summary, offline=True)
        print(f"Verified {out['count']:,} archived transfers offline; summary {args.summary}")
        return
    h = requests.get(PORTAL + "/finalized-head", timeout=20)
    h.raise_for_status()
    if args.end > h.json()["number"]:
        parser.error("Choose an end block at or before the finalized head")
    parts = []
    total = 0
    errors = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(collect, args.archive, a, b): (a, b) for a, b in reversed(ranges)}
        for job in as_completed(jobs):
            try:
                part = job.result()
            except (OSError, ValueError, RuntimeError) as error:
                errors.append((jobs[job], str(error)))
                print(f"Failed {jobs[job]}: {error}", flush=True)
                continue
            parts.append(part)
            total += part["count"]
            print(f"{len(parts)}/{len(ranges)} parts · {total:,} events", flush=True)
    if errors:
        raise SystemExit(f"{len(errors)} incomplete parts; rerun to repair the missing intervals")
    summary = build_index(args.archive, sorted(parts, key=lambda x: x["fromBlock"]), args.summary)
    print(f"Verified {summary['count']:,} Transfer logs; summary {args.summary}", flush=True)


if __name__ == "__main__":
    main()
