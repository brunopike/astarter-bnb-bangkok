"""Verify and mirror the public Astarter block and market archives. Standard library only."""

from brain_market_summary import summarize

import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from datetime import date
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPOSITORY = "brunopike/astarter-bnb-bangkok"
API = "https://api.github.com/repos/" + REPOSITORY
RAW = "https://raw.githubusercontent.com/" + REPOSITORY
EVIDENCE = "src/astarter-frontend/brain-evidence/"
INDEX = {"archive": ("manifest.json", "summary.json"), "tradfi": ("catalog.json", "summary.json")}
SHA = re.compile("[0-9a-f]{64}")
GIT_SHA = re.compile("[0-9a-f]{40}")


def valid(value, message):
    if not value:
        raise ValueError(message)


def download(url):
    headers = {"User-Agent": "Astarter public history mirror/1.0"}
    if url.startswith(API + "/contents/"):
        # The object representation also returns blob metadata for indexes larger than 1 MiB.
        headers["Accept"] = "application/vnd.github.object+json"
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers=headers), timeout=30) as resp:
                return resp.read()
        except HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise
            delay = exc.headers.get("Retry-After", "")
            time.sleep(int(delay) if delay.isdecimal() else 2**attempt)
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(2**attempt)


def pin(explicit):
    sha = explicit or json.loads(download(API + "/commits/main"))["sha"]
    valid(isinstance(sha, str) and GIT_SHA.fullmatch(sha), "Expected a full public Git commit SHA")
    return sha


def trusted_index(sha, group, name):
    name = EVIDENCE + group + "/" + name
    entry = json.loads(download(f"{API}/contents/{name}?ref={sha}"))
    valid(
        entry["type"] == "file" and GIT_SHA.fullmatch(entry["sha"]),
        "Missing GitHub blob metadata for " + name,
    )
    content = download(f"{RAW}/{sha}/{name}")
    git_id = hashlib.sha1(b"blob " + str(len(content)).encode("ascii") + b"\0" + content).hexdigest()
    valid(
        len(content) == entry["size"] and git_id == entry["sha"],
        "Git blob verification failed for " + name,
    )
    return content


def referenced(group, indexes):
    result = {}

    def add(name, sha):
        valid(
            name not in result and isinstance(sha, str) and SHA.fullmatch(sha),
            "Duplicate file or invalid SHA-256: " + name,
        )
        result[name] = sha

    if group == "archive":
        manifest = json.loads(indexes["manifest.json"])
        summary = json.loads(indexes["summary.json"])
        valid(
            manifest["count"] > 0
            and manifest["count"] == sum(d["count"] for d in manifest["datasets"]),
            "Invalid archive total",
        )
        valid(summary["count"] == manifest["count"], "Summary count differs")
        valid(
            all(summary.get(k) == manifest.get(k) for k in ("schemaVersion", "accessedOn")),
            "Archive metadata differs between indexes",
        )
        by_asset = {d["asset"]: d for d in manifest["datasets"]}
        valid(
            len(by_asset) == len(manifest["datasets"]) == len(summary["datasets"]),
            "Duplicate or missing assets",
        )
        valid({d["asset"] for d in summary["datasets"]} == set(by_asset), "Summary networks differ")
        for d in summary["datasets"]:
            dataset = by_asset[d["asset"]]
            valid(
                all(
                    d.get(k) == dataset.get(k)
                    for k in (
                        "count",
                        "start",
                        "end",
                        "ranges",
                        "coverageMode",
                        "heightKind",
                        "transactionCountIncludesVotes",
                    )
                ),
                "Summary coverage differs: " + d["asset"],
            )
        for d in manifest["datasets"]:
            valid(
                d["count"] == sum(s["count"] for s in d["shards"]),
                "Invalid network total: " + d["asset"],
            )
            for s in d["shards"]:
                name = s["file"]
                valid(
                    isinstance(name, str)
                    and re.fullmatch(r"[a-z0-9]+-\d{4}-\d\d-\d\d\.json(?:\.gz)?", name)
                    and name.startswith(d["asset"].lower() + "-")
                    and s["count"] > 0,
                    "Unsafe or invalid archive shard: " + str(name),
                )
                add(name, s["sha256"])
    elif group == "tradfi":
        valid(json.loads(indexes["summary.json"]) == summarize(indexes["catalog.json"]), "Market summary differs from catalog")
        catalog = json.loads(indexes["catalog.json"])
        series = catalog["series"]
        valid(isinstance(series, list) and series, "Empty market catalog")
        files = catalog.get("supportingFiles", {})
        expected = {s["sourceIndex"] for s in series if s.get("sourceIndex")}
        valid(isinstance(files, dict) and set(files) == expected and not expected - {"tw-stock-sources.json"},
              "Invalid market source indexes")
        for name, digest in files.items():
            add(name, digest)
        for item in series:
            key = item["id"]
            valid(
                isinstance(key, str) and re.fullmatch(r"[a-z0-9]+(?:[-_][a-z0-9]+)*", key),
                "Unsafe series ID: " + str(key),
            )
            add(key + ".json", item["sha256"])
            if item.get("statistic") == "exchangeActivity":
                valid(key in ("sec-midas-equities", "sec-midas-etp") and item.get("quarterIndexes"),
                      "Missing quarterly security indexes")
                for chunk in item["quarterIndexes"]:
                    name = chunk["file"]
                    valid(re.fullmatch(re.escape(key) + r"-\d{4}q[1-4]\.json", name)
                          and type(chunk["count"]) is int and 0 < chunk["count"] <= item["count"],
                          "Invalid quarterly security index")
                    add(name, chunk["sha256"])
            if item.get("statistic") in ("wholesaleRange", "wholesaleModal"):
                shards = item["shards"]
                valid(shards and sum(shard["count"] for shard in shards) == item["count"], "Market shard totals differ: " + key)
                months = []
                for shard in shards:
                    month = shard["month"]
                    valid(isinstance(month, str) and re.fullmatch(r"[0-9]{4}-(?:0[1-9]|1[0-2])", month)
                          and type(shard["count"]) is int and shard["count"] > 0, "Invalid market month")
                    valid(shard["start"].startswith(month + "-") and shard["end"].startswith(month + "-")
                          and date.fromisoformat(shard["start"]) <= date.fromisoformat(shard["end"]), "Invalid market coverage")
                    add(key + "-" + month + ".json", shard["sha256"])
                    months.append(month)
                valid(months == sorted(set(months)) and item["start"] == shards[0]["start"]
                      and item["end"] == shards[-1]["end"], "Market shard coverage differs: " + key)
    else:
        raise ValueError("Unknown history group")
    return result


def sha_file(path):
    h = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_local(evidence, group, pathlist):
    folder = evidence / group
    indexes = {name: (folder / name).read_bytes() for name in INDEX[group]}
    refs = referenced(group, indexes)
    for name, expected in refs.items():
        valid(sha_file(folder / name) == expected, "SHA-256 mismatch: " + group + "/" + name)
    checkpoints = []
    if group == "tradfi":
        for network in ("ethereum", "arbitrum", "avax"):
            name = f"coverage-{network}.json"
            if not (folder / name).is_file():
                continue
            state = json.loads((folder / name).read_bytes())
            feeds = state["feeds"]
            dates = state["dates"]
            valid(
                isinstance(feeds, list)
                and feeds
                and all(isinstance(a, str) and re.fullmatch(r"0x[0-9a-fA-F]{40}", a) for a in feeds)
                and len(feeds) == len({a.lower() for a in feeds}),
                "Invalid coverage feeds: " + name,
            )
            valid(
                isinstance(dates, list)
                and all(isinstance(d, str) and date.fromisoformat(d).isoformat() == d for d in dates)
                and len(dates) == len(set(dates)),
                "Invalid coverage dates: " + name,
            )
            checkpoints.append(name)
    if pathlist:
        # Publish validated importer checkpoints but keep them off the read-only server mirror.
        names = [os.fsencode(str(evidence / group / name)) for name in [*refs, *indexes, *checkpoints]]
        pathlist.write_bytes(b"\0".join(names) + b"\0")
    return len(refs)


def install_data(group, stage, sha, active, fallback):
    folder = stage / group
    folder.mkdir()
    indexes = {name: trusted_index(sha, group, name) for name in INDEX[group]}
    refs = referenced(group, indexes)

    def one(pair):
        name, expected = pair
        dest = folder / name
        for base in (active, fallback):
            if not base:
                continue
            prior = base / group / name
            if not prior.is_file() or sha_file(prior) != expected:
                continue
            if base == active:
                # Previous mirror generations are immutable and use the same filesystem.
                os.link(prior, dest)
                return
            shutil.copyfile(prior, dest)
            if sha_file(dest) == expected:
                return
        raw = download(f"{RAW}/{sha}/{EVIDENCE}{group}/{name}")
        valid(
            hashlib.sha256(raw).hexdigest() == expected,
            "Downloaded SHA-256 mismatch: " + group + "/" + name,
        )
        dest.write_bytes(raw)

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as reader:
        list(reader.map(one, refs.items()))
    for name, raw in indexes.items():
        (folder / name).write_bytes(raw)
    return len(refs)


def mirror(root, fallback, revision):
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        sha = pin(revision)
        releases = root / ".releases"
        releases.mkdir(exist_ok=True)
        current = root / ".active"
        target = releases / sha
        active = current.resolve(strict=True) if current.is_symlink() else None
        if active == target:
            print("Current public revision:", sha)
            return
        for group in INDEX:
            alias = root / group
            if alias.is_dir() and not alias.is_symlink() and not any(alias.iterdir()):
                alias.rmdir()
            valid(
                not os.path.lexists(alias)
                or alias.is_symlink()
                and os.readlink(alias) == ".active/" + group,
                "An unmanaged path occupies " + str(alias),
            )
        with tempfile.TemporaryDirectory(prefix=".download-", dir=releases) as tmp:
            stage = Path(tmp) / "release"
            stage.mkdir()
            tot = {group: install_data(group, stage, sha, active, fallback) for group in INDEX}
            if not target.exists():
                os.rename(stage, target)
            else:
                for group, names in INDEX.items():
                    valid(
                        all(
                            (target / group / name).read_bytes() == (stage / group / name).read_bytes()
                            for name in names
                        ),
                        "Stored release indexes differ from the pinned public revision",
                    )
                    verify_local(target, group, None)
        for group in INDEX:
            if not os.path.lexists(root / group):
                (root / group).symlink_to(".active/" + group)
        new = root / ".active-next"
        new.unlink(missing_ok=True)
        new.symlink_to(".releases/" + sha)
        os.replace(new, current)
        # Keep the current and former generation, both fully usable if a rollout must be reverted.
        for older in releases.iterdir():
            if older.is_dir() and GIT_SHA.fullmatch(older.name) and older not in (target, active):
                shutil.rmtree(older)
        print("Installed public revision", sha, tot)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, default=Path("/home/ubuntu/.local/share/astarter/history"))
    p.add_argument("--fallback", type=Path, default=Path("/var/www/astarter/brain-evidence"))
    p.add_argument("--sha", help="Full immutable commit; default resolves public main once")
    p.add_argument("--check-local", type=Path, metavar="EVIDENCE")
    p.add_argument("--group", choices=tuple(INDEX))
    p.add_argument("--path-list", type=Path)
    a = p.parse_args()
    if a.check_local:
        if not a.group:
            p.error("--check-local requires --group")
        print("Verified", verify_local(a.check_local, a.group, a.path_list), a.group, "files")
    else:
        mirror(a.root, a.fallback, a.sha)


if __name__ == "__main__":
    main()
