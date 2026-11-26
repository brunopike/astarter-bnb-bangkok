"""Verify an interrupted download cannot publish half a public history revision."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "history_mirror", Path(__file__).with_name("mirror-brain-history.py")
)
mirror = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirror)


def raw(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def release(amount):
    day = "2024-04-20"
    archive_file = "btc-" + day + ".json"
    market_file = "gold-spot.json"
    content = {
        "archive/" + archive_file: raw([[1, 1713571200, 2]]),
        "tradfi/" + market_file: raw([day, amount]),
    }

    def sha(path):
        return hashlib.sha256(content[path]).hexdigest()

    dataset = {
        "asset": "BTC",
        "count": 1,
        "start": day,
        "end": day,
        "ranges": [{"start": day, "end": day, "count": 1}],
    }
    shard = {
        "file": archive_file,
        "start": day,
        "end": day,
        "count": 1,
        "sha256": sha("archive/" + archive_file),
    }
    content["archive/manifest.json"] = raw({"count": 1, "datasets": [{**dataset, "shards": [shard]}]})
    content["archive/summary.json"] = raw({"count": 1, "datasets": [dataset]})
    content["tradfi/catalog.json"] = raw(
        {"series": [{"id": "gold-spot", "sha256": sha("tradfi/" + market_file)}]}
    )
    return content


class MirrorTests(unittest.TestCase):
    def test_snapshot_is_atomic_and_reuses_previously_verified_content(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()):
            root = Path(folder) / "history"
            fallback = Path(folder) / "deployed"
            first = release(7)
            second = release(8)
            for name, payload in first.items():
                dest = fallback / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(payload)
            root.mkdir()
            (root / "archive").mkdir()
            raw_requests = []

            def remote(sha, group, name):
                return (first if sha == "a" * 40 else second)[group + "/" + name]

            def download(url):
                name = url.split(mirror.EVIDENCE)[1]
                raw_requests.append(name)
                return second[name]

            with (
                patch.object(mirror, "trusted_index", side_effect=remote),
                patch.object(mirror, "download", side_effect=download),
            ):
                mirror.mirror(root, fallback, "a" * 40)
                self.assertEqual(raw_requests, [])
                old = (root / ".active").resolve()
                with (
                    patch.object(mirror, "download", return_value=b"corrupt"),
                    self.assertRaises(ValueError),
                ):
                    mirror.mirror(root, fallback, "b" * 40)
                self.assertEqual((root / ".active").resolve(), old)
                self.assertEqual(
                    (root / "tradfi/gold-spot.json").read_bytes(), first["tradfi/gold-spot.json"]
                )
                mirror.mirror(root, fallback, "b" * 40)
                self.assertEqual(raw_requests, ["tradfi/gold-spot.json"])
                self.assertEqual(
                    (root / "archive/btc-2024-04-20.json").stat().st_ino,
                    (old / "archive/btc-2024-04-20.json").stat().st_ino,
                )
                self.assertEqual(
                    (fallback / "tradfi/gold-spot.json").read_bytes(), first["tradfi/gold-spot.json"]
                )
                mirror.mirror(root, fallback, "b" * 40)
                self.assertEqual(raw_requests, ["tradfi/gold-spot.json"])

    def test_market_checkpoint_is_validated_and_staged(self):
        with tempfile.TemporaryDirectory() as folder:
            evidence = Path(folder)
            target = evidence / "tradfi"
            target.mkdir()
            for name, payload in release(4).items():
                if name.startswith("tradfi/"):
                    (evidence / name).write_bytes(payload)
            cp = target / "coverage-ethereum.json"
            cp.write_bytes(raw({"dates": ["2024-04-20"], "feeds": ["0x" + "a" * 40]}))
            pathlist = evidence / "paths"
            self.assertEqual(mirror.verify_local(evidence, "tradfi", pathlist), 1)
            self.assertIn(os.fsencode(cp), pathlist.read_bytes().split(b"\0"))
            for bad in (
                {"dates": ["2024-02-31"], "feeds": ["0x" + "a" * 40]},
                {"dates": [], "feeds": ["wrong"]},
            ):
                cp.write_bytes(raw(bad))
                with self.assertRaises(ValueError):
                    mirror.verify_local(evidence, "tradfi", pathlist)

    def test_reject_unsafe_names_and_mismatched_summary(self):
        group = release(1)
        manifest = group["archive/manifest.json"]
        with self.assertRaises(ValueError):
            mirror.referenced(
                "archive",
                {"manifest.json": manifest, "summary.json": raw({"count": 2, "datasets": []})},
            )
        with self.assertRaises(ValueError):
            mirror.referenced(
                "tradfi", {"catalog.json": raw({"series": [{"id": "../private", "sha256": "0" * 64}]})}
            )


if __name__ == "__main__":
    unittest.main()
