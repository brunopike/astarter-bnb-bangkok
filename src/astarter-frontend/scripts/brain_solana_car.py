"""Read a bounded window of the public Yellowstone Old Faithful mainnet history.

The CAR file is chronological; an estimated byte position only selects a window.
A returned record uses the timestamp from a content-addressed block and the
transaction links from its entries. No transaction type or execution status is filtered.
"""

import hashlib
import io
import re
import threading
from bisect import bisect_left
from datetime import UTC, datetime, time

import cbor2
import requests

BASE = "https://files.old-faithful.net"
# A CIDv1 for DAG-CBOR / SHA2-256 is followed by its CBOR tuple.
OBJECT = re.compile(rb"\x01\x71\x12\x20.{32}(?=\x84[\x00\x01]|\x85\x00|\x86\x02)", re.DOTALL)
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_local = threading.local()
_sizes = {}
_lock = threading.Lock()


def _b58(raw):
    num = int.from_bytes(raw, "big")
    chars = ""
    while num:
        num, r = divmod(num, 58)
        chars = ALPHABET[r] + chars
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + chars


def _refs(items):
    return [
        tag.value[1:]
        for tag in items
        if isinstance(tag, cbor2.CBORTag) and tag.tag == 42 and tag.value[:1] == b"\0"
    ]


def window_records(raw):
    positions = {m.group(): m.end() for m in OBJECT.finditer(raw)}
    stream = io.BytesIO(raw)
    nodes = {}

    def read(cid):
        if cid not in nodes:
            pos = positions.get(cid)
            if pos is None:
                return None
            stream.seek(pos)
            try:
                node = cbor2.load(stream)
            except (cbor2.CBORDecodeError, ValueError, EOFError):
                return None
            if hashlib.sha256(raw[pos : stream.tell()]).digest() != cid[4:]:
                return None
            nodes[cid] = node
        return nodes[cid]

    for cid, pos in positions.items():
        if raw[pos : pos + 2] != b"\x86\x02":
            continue
        block = read(cid)
        if not block or len(block) != 6 or type(block[1]) is not int or len(block[4]) < 2:
            continue
        slot = block[1]
        stamp = block[4][1]
        if type(stamp) is not int or stamp <= 0:
            continue
        entry_ids = _refs(block[3])
        if len(entry_ids) != len(block[3]) or not entry_ids:
            continue
        last = read(entry_ids[-1])
        if not last or len(last[2]) != 32:
            continue
        blockhash = _b58(last[2])
        # An ordinal on the last transaction in the last non-empty entry is the
        # exact transaction count minus one. The remaining entries must be empty.
        for entry_id in reversed(entry_ids):
            node = read(entry_id)
            if not node:
                break
            if node[3]:
                tx_ids = _refs(node[3])
                if len(tx_ids) != len(node[3]):
                    break
                tx = read(tx_ids[-1])
                ordinal = (
                    tx[4]
                    if tx
                    and len(tx) >= 5
                    and tx[0] == 0
                    and tx[3] == slot
                    and type(tx[4]) is int
                    and tx[4] >= 0
                    else None
                )
                if all(key in positions for key in entry_ids):
                    all_entries = [read(key) for key in entry_ids]
                    if all(entry and entry[0] == 1 for entry in all_entries):
                        count = sum(len(entry[3]) for entry in all_entries)
                        if ordinal is None or count == ordinal + 1:
                            yield (slot, stamp, count, blockhash)
                elif ordinal is not None:
                    yield (slot, stamp, ordinal + 1, blockhash)
                break
        else:
            yield (slot, stamp, 0, blockhash)


def _range(url, start, size):
    if not hasattr(_local, "http"):
        _local.http = requests.Session()
    requested = f"bytes={start}-{start + size - 1}"
    with _local.http.get(
        url, headers={"Range": requested, "Accept-Encoding": "identity"}, timeout=(5, 12), stream=True
    ) as response:
        if response.status_code != 206:
            raise ValueError(f"Archive range unavailable ({response.status_code})")
        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
        if not match or int(match[1]) != start or int(match[2]) >= start + size:
            raise ValueError("Unexpected CAR range")
        length = int(match[2]) - start + 1
        data = response.raw.read(length + 1)
        if len(data) != length:
            raise ValueError("Incomplete CAR range")
        return int(match[3]), data


def approximate(anchors, day):
    target = int(datetime.combine(day, time(12), UTC).timestamp())
    i = bisect_left(anchors, (target, 0))
    if i == 0:
        return anchors[0][1]
    if i == len(anchors):
        return None
    left, a = anchors[i - 1]
    right, b = anchors[i]
    return a + round((target - left) * (b - a) / (right - left))


def sample(day, anchors):
    slot = approximate(anchors, day)
    if slot is None:
        return None
    target = int(datetime.combine(day, time(12), UTC).timestamp())
    # Clock speed and bytes per slot both vary with load. Use the timestamp
    # actually read to correct a misplaced window, even across an epoch boundary.
    estimates = list(anchors)
    for _ in range(4):
        epoch, within = divmod(slot, 432000)
        url = f"{BASE}/{epoch}/epoch-{epoch}.car"
        with _lock:
            size = _sizes.get(epoch)
        if not size:
            size, _ = _range(url, 0, 1)
            with _lock:
                _sizes[epoch] = size
        pos = int(size * within / 432000)
        observed = None
        for length in (384 * 1024, 1536 * 1024, 6 * 1024 * 1024):
            start = max(0, min(size - length, pos))
            _, data = _range(url, start, min(size, length))
            records = list(window_records(data))
            if not records:
                continue
            for s, t, n, h in records:
                if datetime.fromtimestamp(t, UTC).date() == day:
                    return s, t, n, h, url, f"bytes={start}-{start + len(data) - 1}"
            observed = records[len(records) // 2]
            break
        if not observed:
            return None
        observed_slot, stamp = observed[:2]
        estimates = sorted([*estimates, (stamp, observed_slot)])
        correction = approximate(estimates, day)
        if correction is None:
            return None
        # Correct for the measured difference between the requested file fraction
        # and the slot actually found at that fraction.
        revised = correction + (slot - observed_slot)
        if abs(revised - slot) < 500:
            revised = slot + round((target - stamp) * 2)
        slot = max(0, revised)
    return None
