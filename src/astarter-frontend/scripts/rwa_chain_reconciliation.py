"""Reconcile complete BlockPI Ethereum archive shards independently with finalized SQD.

Run against a finished archive or use --from-block/--to-block to reconcile already downloaded parts.
By default any missing receipt, duplicate ID or mismatch fails the check. Receipts can be reused
only when their SHA-256 still matches the local shard.
"""
import argparse
import csv
import gzip
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import time

import requests

URL = "https://portal.sqd.dev/datasets/ethereum-mainnet/stream"
BLOCKPI = "https://ethereum.public.blockpi.network/v1/rpc/public"
TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sign(records):
    h = hashlib.sha256()
    for row in sorted(records):
        h.update((":".join(map(str, row)) + "\n").encode("ascii"))
    return h.hexdigest()


def request(session, query):
    for attempt in range(6):
        try:
            response = session.post(URL, json=query, timeout=(8, 45))
            if response.status_code != 429 and response.status_code < 500:
                response.raise_for_status()
                blocks = [json.loads(line) for line in response.content.splitlines() if line]
                finalized = int(response.headers["X-Sqd-Finalized-Head-Number"])
                if blocks and blocks[-1]["header"]["number"] > finalized:
                    raise ValueError("Reference page includes unfinalized blocks")
                return blocks
            delay = max(2**attempt, float(response.headers.get("Retry-After", 0)))
        except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError,
                requests.exceptions.ContentDecodingError):
            if attempt == 5:
                raise
            delay = 2**attempt
        time.sleep(delay)
    raise ValueError("SQD reconciliation unavailable")


def verify(archive, meta):
    if meta.get("readSource") != BLOCKPI or meta.get("chainId") != 1:
        raise ValueError("This verifier requires an Ethereum BlockPI shard")
    artifact = archive / meta["file"]
    digest = sha(artifact)
    if digest != meta["sha256"]:
        raise ValueError(f"Damaged archive {artifact}")
    verified = archive / "verification" / (artifact.name + ".json")
    if verified.exists():
        previous = json.loads(verified.read_text())
        if (previous.get("sha256") == digest and previous.get("reference") == URL
                and previous.get("verifiedCount") == meta["count"]):
            return previous
    rows = {}
    with gzip.open(artifact, "rt", newline="") as f:
        for event in csv.DictReader(f):
            key = (event["transaction_hash"], int(event["log_index"]))
            if key in rows:
                raise ValueError(f"Duplicate archived identity {key}")
            rows[key] = int(event["amount_raw_uint256"])
    cursor, end = meta["fromBlock"], meta["toBlock"]
    compared = 0
    original = sign(((tx, index, amount) for (tx, index), amount in rows.items()))
    with requests.Session() as session:
        while cursor <= end:
            query = {"type": "evm", "fromBlock": cursor, "toBlock": end,
                     "logs": [{"address": meta["contracts"], "topic0": [TOPIC]}],
                     "fields": {"block": {"number": True}, "log": {"logIndex": True, "transactionHash": True,
                                                                     "data": True}}}
            blocks = request(session, query)
            if not blocks or blocks[0]["header"]["number"] != cursor:
                raise ValueError(f"Missing SQD boundary at {cursor}")
            previous = cursor - 1
            for block in blocks:
                height = block["header"]["number"]
                if not previous < height <= end:
                    raise ValueError(f"Invalid SQD order in {meta['file']}")
                previous = height
                for ev in block.get("logs", []):
                    key = (ev["transactionHash"].lower(), ev["logIndex"])
                    if rows.pop(key, None) != int(ev["data"], 16):
                        raise ValueError(f"Missing transaction or amount mismatch {meta['file']} {key}")
                    compared += 1
            cursor = previous + 1
    if rows or compared != meta["count"]:
        raise ValueError(f"Extra archived events in {meta['file']}")
    out = {"file": meta["file"], "fromBlock": meta["fromBlock"], "toBlock": end,
           "source": BLOCKPI, "reference": URL, "sha256": digest, "verifiedCount": compared,
           "verifiedFields": ["transaction_hash", "log_index", "amount_raw_uint256"],
           "sortedRecordsSha256": original}
    verified.parent.mkdir(parents=True, exist_ok=True)
    tmp = verified.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, indent=2) + "\n")
    tmp.replace(verified)
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--from-block", type=int)
    parser.add_argument("--to-block", type=int)
    parser.add_argument("--workers", type=int, choices=[1, 2, 3], default=2)
    args = parser.parse_args()
    parts = sorted(args.archive.glob("*.csv.meta.json"))
    selected = []
    for file in parts:
        meta = json.loads(file.read_text())
        if (meta.get("readSource") == BLOCKPI
            and (args.from_block is None or meta["fromBlock"] >= args.from_block)
            and (args.to_block is None or meta["toBlock"] <= args.to_block)):
            selected.append(meta)
    with ThreadPoolExecutor(args.workers) as ex:
        total = 0
        failures = []
        futures = {ex.submit(verify, args.archive, meta): meta["file"] for meta in selected}
        for job in as_completed(futures):
            try:
                proof = job.result()
            except (ValueError, RuntimeError, OSError) as error:
                failures.append(futures[job])
                print(f"Failed {futures[job]}: {error}", flush=True)
                continue
            total += proof["verifiedCount"]
            print(f"{proof['file']} · {proof['verifiedCount']:,} exact matches", flush=True)
    if failures:
        raise SystemExit(f"{len(failures)} shards need independent reconciliation")
    print(f"Verified {len(selected)} shards; {total:,} matching events", flush=True)


if __name__ == "__main__":
    main()
