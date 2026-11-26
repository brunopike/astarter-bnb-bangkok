"""Archive one confirmed-time, finalized mainnet-beta block per UTC date.

The cold backfill reads CID-verified Old Faithful CAR records. For daily updates,
SQD locates a produced slot and the Solana RPC returns the block time, hash
and signatures. Both paths include validator votes and failed transactions.
"""

import concurrent.futures
import gzip
import hashlib
import json
import os
import re
import tempfile
import threading
import time
from bisect import bisect_left
from datetime import UTC, date, datetime, timedelta
from datetime import time as clock_time
from itertools import pairwise
from pathlib import Path

import requests

FIRST_DAY = date(2020, 10, 7)
PORTAL = "https://portal.sqd.dev/datasets/solana-mainnet"
RPC = (
    "https://api.mainnet-beta.solana.com",
    "https://solana-mainnet.gateway.tatum.io",
    "https://solana-rpc.publicnode.com",
)
GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
DOC = "https://solana.com/docs/rpc/http/getblock"
BASE58 = re.compile(r"[1-9A-HJ-NP-Za-km-z]+")
_tls = threading.local()
_lock = threading.Lock()
_next = {}
_verified = set()


def _write(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        f.write(raw)
        temp = f.name
    try:
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def _json(obj):
    return (json.dumps(obj, separators=(",", ":")) + "\n").encode()


def _http(url, payload=None):
    if not hasattr(_tls, "http"):
        _tls.http = requests.Session()
    service = url.split("/")[2]
    error = None
    for attempt in range(5):
        with _lock:
            ready = max(time.monotonic(), _next.get(service, 0))
            _next[service] = ready + (0.24 if service == "portal.sqd.dev" else 0.31)
        time.sleep(max(0, ready - time.monotonic()))
        try:
            r = _tls.http.request(
                "POST" if payload is not None else "GET", url, json=payload, timeout=(7, 22)
            )
            if r.status_code in (429, 503, 529):
                try:
                    pause = max(0, float(r.headers.get("Retry-After") or 0))
                except ValueError:
                    pause = 0
                if pause:
                    with _lock:
                        _next[service] = max(_next.get(service, 0), time.monotonic() + pause)
                raise RuntimeError(f"{service} HTTP {r.status_code}")
            r.raise_for_status()
            return r.json()
        except requests.HTTPError as exc:
            if exc.response is not None and 400 <= exc.response.status_code < 500:
                raise RuntimeError(f"{service} HTTP {exc.response.status_code}") from exc
            error = exc
        except (requests.RequestException, ValueError, RuntimeError) as exc:
            error = exc
            if attempt < 4:
                time.sleep(min(5, 0.35 * 2**attempt))
    raise RuntimeError(f"Read failed at {service}: {error}")


def _rpc(url, method, params):
    ans = _http(url, {"id": 1, "jsonrpc": "2.0", "method": method, "params": params})
    if not isinstance(ans, dict) or ans.get("id") != 1 or "result" not in ans or "error" in ans:
        raise RuntimeError(f"{method}: {str(ans.get('error') if isinstance(ans, dict) else ans)[:160]}")
    return ans["result"]


def _day_slot(day, hour):
    timestamp = int(datetime.combine(day, clock_time(hour), UTC).timestamp())
    url = f"{PORTAL}/timestamps/{timestamp}/block"
    ans = _http(url)
    slot = ans.get("block_number") if isinstance(ans, dict) else None
    if type(slot) is not int or slot < 0:
        raise ValueError(f"SQD did not return a slot for {day}")
    return slot, url


def _validate_block(block, day):
    if not block or not isinstance(block, dict):
        raise ValueError("Selected Solana slot has no finalized block")
    ts, signatures, blockhash = (block.get(k) for k in ("blockTime", "signatures", "blockhash"))
    if type(ts) is not int or ts <= 0:
        raise ValueError("Solana block lacks a native UTC timestamp")
    if datetime.fromtimestamp(ts, UTC).date() != day:
        return None
    if (
        not isinstance(blockhash, str)
        or not (32 <= len(blockhash) <= 44)
        or not BASE58.fullmatch(blockhash)
    ):
        raise ValueError("Invalid Solana blockhash")
    if (
        not isinstance(signatures, list)
        or not all(
            isinstance(v, str) and 64 <= len(v) <= 88 and BASE58.fullmatch(v) for v in signatures
        )
        or len(set(signatures)) != len(signatures)
    ):
        raise ValueError("Invalid ordered transaction signature list")
    return ts, len(signatures), blockhash


def _read_slot(slot, day, urls=RPC):
    last = None
    for url in urls:
        try:
            if url not in _verified:
                if _rpc(url, "getGenesisHash", []) != GENESIS:
                    raise RuntimeError("Unexpected Solana network")
                with _lock:
                    _verified.add(url)
            block = _rpc(
                url,
                "getBlock",
                [
                    slot,
                    {
                        "commitment": "finalized",
                        "transactionDetails": "signatures",
                        "rewards": False,
                        "maxSupportedTransactionVersion": 0,
                    },
                ],
            )
            return _validate_block(block, day), url
        except (ValueError, RuntimeError) as exc:
            last = exc
    raise RuntimeError(f"No finalized mainnet block at slot {slot}: {last}")


def _slot_anchors(cache):
    stored = cache / "slot-clock-v1.json"
    anchors = dict(json.loads(stored.read_text())) if stored.is_file() else {}
    ceiling = _rpc(RPC[0], "getSlot", [{"commitment": "finalized"}])
    if type(ceiling) is not int or ceiling <= 39_824_214:
        raise ValueError("Missing finalized Solana tip")
    slots = [39_824_214, *range(40_000_000, ceiling, 2_000_000), ceiling - 256]
    missing = [s for s in slots if str(s) not in anchors]
    for i in range(0, len(missing), 5):
        subset = missing[i : i + 5]
        query = [
            {"id": j, "jsonrpc": "2.0", "method": "getBlockTime", "params": [slot]}
            for j, slot in enumerate(subset)
        ]
        reply = _http(RPC[0], query)
        if not isinstance(reply, list):
            continue
        for item in reply:
            j = item.get("id")
            ts = item.get("result")
            if type(j) is int and 0 <= j < len(subset) and type(ts) is int and ts > 0:
                anchors[str(subset[j])] = ts
    _write(stored, _json(anchors))
    return sorted((ts, int(slot)) for slot, ts in anchors.items())


def _recent_anchors(parts, dest):
    """Use a prior real sample and the finalized tip when the UTC locator is down."""
    try:
        last = parts[max(parts)]
        slot, stamp, _ = json.loads(gzip.decompress((dest / last["file"]).read_bytes()))
        latest = _rpc(RPC[0], "getSlot", [{"commitment": "finalized"}])
        latest_stamp = _rpc(RPC[0], "getBlockTime", [latest])
        if type(latest) is int and type(latest_stamp) is int and latest > slot and latest_stamp > stamp:
            return [(stamp, slot), (latest_stamp, latest)]
    except (ValueError, RuntimeError, OSError):
        pass
    return []


def _sample(day, anchors=(), archive_only=False):
    if anchors:
        try:
            import brain_solana_car as car

            sample = car.sample(day, anchors)
            if sample:
                return sample
        except (ImportError, ValueError, requests.RequestException):
            pass
        if archive_only:
            raise RuntimeError(f"CAR window did not contain a complete sample for {day}")
        noon = int(datetime.combine(day, clock_time(12), UTC).timestamp())
        index = bisect_left(anchors, (noon, 0))
        if index == 0:
            slot = anchors[0][1]
        elif index < len(anchors):
            ta, a = anchors[index - 1]
            tb, b = anchors[index]
            slot = a + round((noon - ta) * (b - a) / (tb - ta))
        else:
            slot = None
        if slot is not None:
            # The estimate selects a request only. Archive the exact RPC slot, time and signatures.
            urls = RPC
            try:
                result, rpc = _read_slot(slot, day, urls)
                if result:
                    ts, count, blockhash = result
                    return slot, ts, count, blockhash, rpc, None
            except RuntimeError:
                pass
    visited = set()
    for hour in (12, 0):
        slot, locator = _day_slot(day, hour)
        if slot in visited:
            continue
        visited.add(slot)
        result, rpc = _read_slot(slot, day)
        if result:
            ts, count, blockhash = result
            return slot, ts, count, blockhash, rpc, locator
    raise ValueError(f"No verified UTC block for {day}; no count was recorded")


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _one_day(day, dest, cache, anchors=(), archive_only=False):
    label = day.isoformat()
    name = f"sol-{label}.json.gz"
    file = dest / name
    previous = cache / (name + ".receipt")
    if previous.is_file() and file.is_file():
        part = json.loads(previous.read_bytes())
        if part["file"] == name and _digest(file.read_bytes()) == part["sha256"]:
            return part
    slot, ts, count, blockhash, rpc, locator = _sample(day, anchors, archive_only)
    raw = gzip.compress(_json([slot, ts, [0, 0, count]]), compresslevel=9, mtime=0)
    part = {
        "file": name,
        "start": label,
        "end": label,
        "count": 1,
        "firstHeight": slot,
        "lastHeight": slot,
        "sha256": _digest(raw),
        "encoding": "delta-triples+gzip",
        "blockHash": blockhash,
        "sources": [
            {"url": f"https://explorer.solana.com/block/{slot}"},
            {
                "url": rpc,
                "method": "getBlock",
                "commitment": "finalized",
                "transactionDetails": "signatures",
            },
        ],
    }
    if locator:
        part["sources"].append({"url": locator})
    if rpc.startswith("https://files.old-faithful.net/"):
        part["sources"] = [
            {"url": f"https://explorer.solana.com/block/{slot}"},
            {"url": rpc, "range": locator, "method": "CID-verified block and entry transaction links"},
        ]
    _write(file, raw)
    _write(previous, _json(part))
    return part


def update_chain(asset, previous_dataset_or_None, dest: Path, until: date):
    if asset != "SOL" or until < FIRST_DAY or until >= datetime.now(UTC).date():
        raise ValueError("SOL requires a completed UTC day in the verified timestamp range")
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    cache = Path(os.environ.get("SOLANA_ARCHIVE_CACHE") or str(dest.parent / ".solana-block-receipts"))
    cache.mkdir(parents=True, exist_ok=True)
    previous = previous_dataset_or_None or {}
    if previous and (previous.get("asset") != "SOL" or previous.get("coverageMode") != "sampled"):
        raise ValueError("Refusing to merge incompatible SOL data")
    parts = {p["start"]: p for p in previous.get("shards", [])}
    if len(parts) != len(previous.get("shards", [])):
        raise ValueError("Duplicate UTC day in previous Solana dataset")
    for day, part in parts.items():
        if (
            part.get("file") != f"sol-{day}.json.gz"
            or not (dest / part["file"]).is_file()
            or _digest((dest / part["file"]).read_bytes()) != part["sha256"]
        ):
            raise ValueError("Missing or changed prior SOL file: " + str(part.get("file")))
        if part.get("end") != day or part.get("count") != 1:
            raise ValueError("Invalid previous daily SOL coverage: " + day)
    days = [FIRST_DAY + timedelta(days=i) for i in range((until - FIRST_DAY).days + 1)]
    pending = [d for d in days if d.isoformat() not in parts]
    cold = len(pending) > 60
    anchors = (
        _slot_anchors(cache) if cold else _recent_anchors(parts, dest) if pending and parts else ()
    )
    # Cover both ends of the time span early. Retries reuse verified per-day receipts.
    if cold and anchors:
        pending = [d for pair in zip(pending, reversed(pending)) for d in pair][: len(pending)]
    # Long-lived RPC limits must not tie up workers reading independent archive epochs.
    for archive_only in (True, False) if cold and anchors else (False,):
        errors = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=16 if archive_only else 3) as pool:
            futures = {pool.submit(_one_day, d, dest, cache, anchors, archive_only): d for d in pending}
            for future in concurrent.futures.as_completed(futures):
                day = futures[future]
                try:
                    parts[day.isoformat()] = future.result()
                except (ValueError, RuntimeError, OSError) as exc:
                    errors[day] = str(exc)
        if not errors:
            break
        pending = sorted(errors)
    if errors:
        detail = ", ".join(f"{day}: {errors[day]}" for day in pending[:7])
        raise RuntimeError(f"{len(errors)} SOL day(s) incomplete: " + detail)
    ordered = [parts[k] for k in sorted(parts)]
    if any(p["count"] != 1 or p["firstHeight"] != p["lastHeight"] for p in ordered) or any(
        a["lastHeight"] >= b["firstHeight"] for a, b in pairwise(ordered)
    ):
        raise ValueError("Duplicate or unordered sampled Solana slots")
    first, last = ordered[0]["start"], ordered[-1]["end"]
    return {
        "id": "sol-blocks",
        "asset": "SOL",
        "source": "Solana mainnet-beta · Old Faithful / finalized RPC",
        "sourceUrl": DOC,
        "fields": ["height", "timestamp", "transactions"],
        "coverageMode": "sampled",
        "heightKind": "slot",
        "network": "Solana mainnet-beta",
        "transactionCountIncludesVotes": True,
        "sampling": "One real finalized block per covered UTC day, aiming near noon when available.",
        "timestampCoverageStart": FIRST_DAY.isoformat(),
        "count": len(ordered),
        "start": first,
        "end": last,
        "ranges": [{"start": first, "end": last, "count": len(ordered)}],
        "shards": ordered,
    }
