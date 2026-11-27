"""Read Transfer logs using public EVM JSON-RPC, including canonical boundary checks."""
import time

import requests

URL = "https://ethereum.public.blockpi.network/v1/rpc/public"


def rpc(session, method, params, endpoint=URL):
    for attempt in range(5):
        delay = 2 ** attempt
        try:
            response = session.post(endpoint, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                                    timeout=(8, 55))
            delay = max(delay, float(response.headers.get("Retry-After", 0)))
            if response.status_code not in (429, 502, 503, 504):
                response.raise_for_status()
                body = response.json()
                error = body.get("error")
                if not error:
                    return body["result"]
                if error.get("code") not in (-32005, -32016, 429):
                    raise ValueError(f"{method} failed: {error}")
        except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError,
                requests.exceptions.ContentDecodingError):
            if attempt == 4:
                raise
        time.sleep(delay)
    raise RuntimeError(f"{endpoint}: {method} unavailable")


def header(session, height, endpoint):
    result = rpc(session, "eth_getBlockByNumber", [hex(height), False], endpoint)
    if not result or int(result["number"], 16) != height:
        raise ValueError(f"Missing block {height}")
    return {"number": height, "hash": result["hash"].lower(), "timestamp": int(result["timestamp"], 16)}


def page(session, start, end, contracts, transfer, endpoint=URL, range_limit=2500):
    end = min(end, start + range_limit - 1)
    while True:
        args = {"fromBlock": hex(start), "toBlock": hex(end), "address": list(contracts), "topics": [transfer]}
        logs = rpc(session, "eth_getLogs", [args], endpoint)
        if len(logs) < 8000:
            break
        if start == end:
            raise ValueError(f"Ambiguous oversized log response at block {start}")
        end = (start + end) // 2
    blocks = {}
    for event in logs:
        height = int(event["blockNumber"], 16)
        if not start <= height <= end or event.get("removed") is not False:
            raise ValueError("Unexpected removed or out-of-range log")
        b = {"number": height, "timestamp": int(event["blockTimestamp"], 16), "hash": event["blockHash"].lower()}
        block = blocks.setdefault(height, {"header": b, "logs": []})
        if block["header"] != b:
            raise ValueError(f"Inconsistent block header {height}")
        block["logs"].append({"address": event["address"].lower(), "logIndex": int(event["logIndex"], 16),
                              "transactionHash": event["transactionHash"].lower(), "topics": event["topics"],
                              "data": event["data"]})
    for height in sorted({start, end}):
        h = header(session, height, endpoint)
        if blocks.setdefault(height, {"header": h, "logs": []})["header"] != h:
            raise ValueError(f"RPC boundary mismatch at {height}")
    return [blocks[h] for h in sorted(blocks)]
