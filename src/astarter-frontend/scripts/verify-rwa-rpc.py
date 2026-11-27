"""Reconcile archived Ethereum BlockPI logs with Tenderly's independent historical RPC."""

import argparse
import csv
import gzip
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

RPC = "https://gateway.tenderly.co/public/mainnet"
BLOCKPI = "https://ethereum.public.blockpi.network/v1/rpc/public"
TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


def read_logs(session, start, end, contracts):
    query = {
        "fromBlock": hex(start),
        "toBlock": hex(end),
        "address": contracts,
        "topics": [TOPIC],
    }
    for attempt in range(6):
        try:
            resp = session.post(
                RPC,
                json={
                    "id": 1,
                    "jsonrpc": "2.0",
                    "method": "eth_getLogs",
                    "params": [query],
                },
                timeout=(8, 50),
            )
            if resp.status_code in (429, 502, 503, 504):
                time.sleep(max(float(resp.headers.get("Retry-After", 0)), 2**attempt))
                continue
            resp.raise_for_status()
            body = resp.json()
            if "result" in body:
                return body["result"]
            msg = str(body.get("error", "unexpected RPC result")).lower()
            if ("limit" in msg or "range" in msg or "too many" in msg) and end > start:
                mid = (start + end) // 2
                return read_logs(session, start, mid, contracts) + read_logs(
                    session, mid + 1, end, contracts
                )
            raise RuntimeError(msg)
        except (
            requests.ConnectionError,
            requests.Timeout,
            requests.exceptions.ChunkedEncodingError,
        ):
            if attempt == 5:
                raise
            time.sleep(2**attempt)
    raise RuntimeError(f"No historical response for {start}–{end}")


def verify(args):
    archive, meta = args
    path = archive / meta["file"]
    out = archive / "verification-tenderly" / (path.name + ".json")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != meta["sha256"]:
        raise ValueError(f"Shard hash mismatch: {path.name}")
    if out.exists():
        prior = json.loads(out.read_text())
        if (
            prior.get("sha256") == digest
            and prior.get("verifiedCount") == meta["count"]
            and prior.get("reference") == RPC
        ):
            return prior["verifiedCount"]
    with gzip.open(path, "rt", newline="") as f:
        expected = {
            (r["transaction_hash"], int(r["log_index"])): (
                int(r["block_number"]),
                r["block_hash"],
                r["contract"],
                r["from_address"],
                r["to_address"],
                int(r["amount_raw_uint256"]),
            )
            for r in csv.DictReader(f)
        }
    count = len(expected)
    if count != meta["count"]:
        raise ValueError(f"Duplicate identity in {path.name}")
    with requests.Session() as session:
        for start in range(meta["fromBlock"], meta["toBlock"] + 1, 1500):
            end = min(start + 1499, meta["toBlock"])
            for row in read_logs(session, start, end, meta["contracts"]):
                key = (row["transactionHash"].lower(), int(row["logIndex"], 16))
                topics = row["topics"]
                height = int(row["blockNumber"], 16)
                if (
                    len(topics) != 3
                    or topics[0] != TOPIC
                    or row.get("removed")
                    or not start <= height <= end
                ):
                    raise ValueError(
                        f"Unexpected log from independent reader: {path.name} {key}"
                    )
                evidence = (
                    height,
                    row["blockHash"].lower(),
                    row["address"].lower(),
                    "0x" + topics[1][-40:].lower(),
                    "0x" + topics[2][-40:].lower(),
                    int(row["data"], 16),
                )
                if expected.pop(key, None) != evidence:
                    raise ValueError(
                        f"Missing or mismatched record in {path.name} {key}"
                    )
    if expected:
        raise ValueError(
            f"{len(expected)} archived records absent from independent reader for {path.name}"
        )
    receipt = {
        "file": path.name,
        "source": BLOCKPI,
        "reference": RPC,
        "sha256": digest,
        "verifiedCount": count,
        "fromBlock": meta["fromBlock"],
        "toBlock": meta["toBlock"],
        "verifiedFields": [
            "transaction_hash",
            "log_index",
            "block_number",
            "block_hash",
            "contract",
            "from_address",
            "to_address",
            "amount_raw_uint256",
        ],
    }
    out.parent.mkdir(exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(receipt, indent=2) + "\n")
    tmp.replace(out)
    print(f"{path.name}: {count:,} independent matches", flush=True)
    return count


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--workers", type=int, choices=(1, 2, 3), default=2)
    args = parser.parse_args()
    parts = [
        json.loads(p.read_text()) for p in sorted(args.archive.glob("*.meta.json"))
    ]
    shards = [
        (args.archive, p)
        for p in parts
        if p.get("readSource") == BLOCKPI and p.get("chainId") == 1
    ]
    if not shards:
        parser.error("No Ethereum BlockPI shards found")
    with ThreadPoolExecutor(args.workers) as pool:
        total = sum(pool.map(verify, shards))
    print(f"{len(shards)} shards, {total:,} records matched the independent reader")
