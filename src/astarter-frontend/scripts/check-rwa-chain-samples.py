"""Independently check Ethereum samples and complete block windows with an explorer or public RPC."""
import argparse
import csv
import gzip
import hashlib
from datetime import datetime, timezone
import json
from pathlib import Path
import time

import requests
from rwa_eth_rpc import rpc

API = "https://eth.blockscout.com/api"
MEV_RPC = "https://rpc.mevblocker.io"
TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


def read(session, url, params=None, want_logs=False):
    for attempt in range(4):
        delay = 2 ** attempt
        try:
            response = session.get(url, params=params, timeout=(6, 25))
            delay = max(delay, float(response.headers.get("Retry-After", 0)))
            if response.status_code != 429 and response.status_code < 500:
                response.raise_for_status()
                payload = response.json()
                if not want_logs or isinstance(payload.get("result"), list):
                    return response.url, payload
        except (requests.ConnectionError, requests.Timeout):
            if attempt == 3:
                raise
        if attempt < 3:
            time.sleep(delay)
    raise RuntimeError(f"Blockscout unavailable at {url}")


def check_sample(session, sample, rpc_url=None):
    if rpc_url:
        tx = sample["id"].split(":")[1]
        receipt = rpc(session, "eth_getTransactionReceipt", [tx], rpc_url)
        header = rpc(session, "eth_getBlockByNumber", [hex(sample["block"]), False], rpc_url)
        matches = [ev for ev in receipt["logs"] if int(ev["logIndex"], 16) == sample["logIndex"]]
        if len(matches) != 1:
            raise ValueError(f"Missing or ambiguous receipt log: {sample['id']}")
        event = matches[0]
        stamp = datetime.fromtimestamp(int(header["timestamp"], 16), timezone.utc).isoformat().replace("+00:00", "Z")
        if not (receipt["transactionHash"].lower() == tx == event["transactionHash"].lower()
                and int(receipt["status"], 16) == 1 and event.get("removed") is not True
                and int(event["blockNumber"], 16) == sample["block"]
                and header["hash"].lower() == event["blockHash"].lower() == sample["blockHash"]
                and stamp == sample["date"] and event["address"].lower() == sample["contract"]
                and len(event["topics"]) == 3 and event["topics"][0].lower() == TOPIC
                and "0x" + event["topics"][1][-40:].lower() == sample["from"]
                and "0x" + event["topics"][2][-40:].lower() == sample["to"]
                and int(event["data"], 16) == int(sample["amountRaw"])):
            raise ValueError(f"Receipt differs for {sample['id']}")
        return {"id": sample["id"], "date": stamp, "block": sample["block"], "label": sample["label"],
                "source": rpc_url, "verified": True}
    parameters = {"module": "logs", "action": "getLogs", "fromBlock": sample["block"],
                  "toBlock": sample["block"], "address": sample["contract"], "topic0": TOPIC}
    source, content = read(session, API, parameters, want_logs=True)
    tx = sample["id"].split(":")[1]
    matches = [log for log in content["result"] if log["transactionHash"].lower() == tx
               and int(log["logIndex"], 16) == sample["logIndex"]]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one match for {sample['id']}")
    event = matches[0]
    stamp = datetime.fromtimestamp(int(event["timeStamp"], 16), timezone.utc).isoformat().replace("+00:00", "Z")
    block_url, block = read(session, f"https://eth.blockscout.com/api/v2/blocks/{sample['block']}")
    checks = {"block number": int(event["blockNumber"], 16) == sample["block"],
              "block hash": block["hash"].lower() == sample["blockHash"],
              "UTC timestamp": stamp == sample["date"],
              "contract": event["address"].lower() == sample["contract"],
              "signature": event["topics"][0].lower() == TOPIC,
              "sender": "0x" + event["topics"][1][-40:].lower() == sample["from"],
              "recipient": "0x" + event["topics"][2][-40:].lower() == sample["to"],
              "raw amount": int(event["data"], 16) == int(sample["amountRaw"])}
    if not all(checks.values()):
        raise ValueError(f"Mismatch {sample['id']}: {checks}")
    return {"id": sample["id"], "date": stamp, "block": sample["block"], "label": sample["label"],
            "explorerQuery": source, "blockUrl": block_url, "verified": True}


def window_receipt(session, root, part, contracts, rpc_url=None):
    center = (part["fromBlock"] + part["toBlock"]) // 2
    window_start = max(part["fromBlock"], center - 4)
    window_end = min(part["toBlock"], center + 4)
    with gzip.open(root / part["file"], "rt", newline="") as stream:
        local = sorted((row["transaction_hash"], int(row["log_index"]), row["contract"], row["amount_raw_uint256"])
                       for row in csv.DictReader(stream) if window_start <= int(row["block_number"]) <= window_end)
    external = []
    if rpc_url:
        logs = rpc(session, "eth_getLogs", [{"fromBlock": hex(window_start), "toBlock": hex(window_end),
                                              "address": contracts, "topics": [TOPIC]}], rpc_url)
        external = [(e["transactionHash"].lower(), int(e["logIndex"], 16), e["address"].lower(),
                     str(int(e["data"], 16))) for e in logs]
    for address in ([] if rpc_url else contracts):
        params = {"module": "logs", "action": "getLogs", "address": address, "topic0": TOPIC,
                  "fromBlock": window_start, "toBlock": window_end}
        _, result = read(session, API, params, want_logs=True)
        logs = result.get("result")
        if not isinstance(logs, list) or len(logs) >= 1000 or (not logs and
                str(result.get("message")).lower() not in ("ok", "no logs found", "no records found")):
            raise ValueError(f"Ambiguous explorer response for {address} at {window_start}: {str(result)[:100]}")
        external.extend((event["transactionHash"].lower(), int(event["logIndex"], 16), event["address"].lower(),
                         str(int(event["data"], 16))) for event in logs)
    if local != sorted(external):
        raise ValueError(f"Full source reconciliation failed at {window_start}..{window_end}")
    return {"fromBlock": window_start, "toBlock": window_end, "matchingEvents": len(local),
            "sha256": hashlib.sha256(json.dumps(local, separators=(",", ":")).encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("summary", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--archive", type=Path, help="Also reconcile three small complete block windows")
    parser.add_argument("--source", choices=["blockscout", "mevblocker"], default="blockscout")
    args = parser.parse_args()
    endpoint = MEV_RPC if args.source == "mevblocker" else None
    data = json.loads(args.summary.read_text())
    if data.get("chainId") != 1:
        parser.error("Only Ethereum mainnet is supported")
    with requests.Session() as session:
        samples = [check_sample(session, sample, endpoint) for sample in data["samples"]]
        windows = []
        if args.archive:
            manifest = args.archive / "manifest.json"
            if hashlib.sha256(manifest.read_bytes()).hexdigest() != data["archiveManifestSha256"]:
                raise ValueError("Manifest does not match the published summary")
            parts = json.loads(manifest.read_text())["shards"]
            for i in sorted({0, len(parts) // 2, len(parts) - 1}):
                windows.append(window_receipt(session, args.archive, parts[i],
                                              [asset["address"] for asset in data["assetContracts"]], endpoint))
    report = {"checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": endpoint or API,
              "archiveManifestSha256": data["archiveManifestSha256"], "verifiedSamples": samples,
              "completeBlockWindows": windows}
    out = args.output.with_suffix(".tmp")
    out.write_text(json.dumps(report, indent=2) + "\n")
    out.replace(args.output)
    print("Independently verified", len(samples), "Ethereum logs")


if __name__ == "__main__":
    main()
