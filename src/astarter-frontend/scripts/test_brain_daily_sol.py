"""Offline regression checks for finalized daily Solana samples."""

import gzip
import hashlib
import json
import tempfile
import unittest
from datetime import UTC, date, datetime
from pathlib import Path
from unittest.mock import patch

import brain_daily_sol as sol


class FinalizedRPCTests(unittest.TestCase):
    def test_missing_is_not_zero_and_dates_are_checked(self):
        day = date(2024, 4, 20)
        ts = 1713571200
        block = {"blockTime": ts, "blockhash": "B" * 44, "signatures": ["C" * 87, "D" * 87]}
        self.assertEqual(sol._validate_block(block, day), (ts, 2, "B" * 44))
        self.assertIsNone(sol._validate_block(block, date(2024, 4, 19)))
        self.assertEqual(sol._validate_block({**block, "signatures": []}, day)[1], 0)
        for key in block:
            with self.assertRaises(ValueError):
                sol._validate_block({**block, key: None}, day)
        with self.assertRaises(ValueError):
            sol._validate_block({**block, "signatures": ["C" * 87] * 2}, day)

    def test_refresh_preserves_a_verified_existing_day(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(sol, "FIRST_DAY", date(2024, 4, 20)):
            archive = Path(folder) / "archive"

            def sample(day, anchors, archive_only=False):
                stamp = int(datetime(day.year, day.month, day.day, 12, tzinfo=UTC).timestamp())
                return 200 + day.day, stamp, day.day, "B" * 44, sol.RPC[0], None

            with (
                patch.object(sol, "_sample", side_effect=sample) as fetch,
                patch.object(sol, "_recent_anchors", return_value=[]),
            ):
                first = sol.update_chain("SOL", None, archive, date(2024, 4, 20))
                second = sol.update_chain("SOL", first, archive, date(2024, 4, 21))
                self.assertEqual(fetch.call_count, 2)
                self.assertEqual(sol.update_chain("SOL", second, archive, date(2024, 4, 21)), second)
                self.assertEqual(fetch.call_count, 2)
            self.assertEqual(second["count"], 2)
            self.assertTrue(second["transactionCountIncludesVotes"])
            part = second["shards"][0]
            raw = (archive / part["file"]).read_bytes()
            self.assertEqual(part, first["shards"][0])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), part["sha256"])
            self.assertEqual(json.loads(gzip.decompress(raw)), [220, 1713614400, [0, 0, 20]])
            (archive / part["file"]).write_bytes(b"bad")
            with self.assertRaises(ValueError):
                sol.update_chain("SOL", second, archive, date(2024, 4, 21))

    def test_no_sample_is_published_for_failed_source(self):
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(sol, "FIRST_DAY", date(2024, 4, 20)),
            patch.object(sol, "_sample", side_effect=RuntimeError("source unavailable")),
        ):
            with self.assertRaisesRegex(RuntimeError, "2024-04-20"):
                sol.update_chain("SOL", None, Path(folder) / "archive", date(2024, 4, 20))
            self.assertEqual(list((Path(folder) / "archive").iterdir()), [])


class CARTests(unittest.TestCase):
    def test_partial_window_only_accepts_hashed_links_with_matching_slot(self):
        import brain_solana_car as car
        import cbor2

        buffer = bytearray()

        def node(data):
            raw = cbor2.dumps(data)
            cid = b"\x01\x71\x12\x20" + hashlib.sha256(raw).digest()
            buffer.extend(cid + raw)
            return cbor2.CBORTag(42, b"\0" + cid)

        slot = 14
        stamp = 1713571200
        tx = node([0, [], [], slot, 69])
        entry = node([1, 1, b"t" * 32, [tx]])
        tail = node([1, 1, b"u" * 32, []])
        previous = cbor2.CBORTag(42, b"\0\x01\x71\x12\x20" + b"p" * 32)
        node([2, slot, [], [previous, entry, tail], [13, stamp], None])
        full = bytes(buffer)
        self.assertEqual(list(car.window_records(full)), [(slot, stamp, 70, car._b58(b"u" * 32))])
        # A missing last entry makes both block hash and transaction count unverifiable.
        truncated = full.replace(b"u" * 32, b"x" * 32)
        self.assertEqual(list(car.window_records(truncated)), [])
        self.assertEqual(list(car.window_records(full[:-12])), [])
        buffer.clear()
        tx = node([0, [], [], slot, None])
        entry = node([1, 1, b"t" * 32, [tx]])
        node([2, slot, [], [entry], [13, stamp], None])
        self.assertEqual(
            list(car.window_records(bytes(buffer))), [(slot, stamp, 1, car._b58(b"t" * 32))]
        )


if __name__ == "__main__":
    unittest.main()
