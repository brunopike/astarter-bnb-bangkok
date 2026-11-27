"""Regression checks for block cursors, event identity, raw units and BSC subsecond blocks."""
from importlib import util
from pathlib import Path
import tempfile
import json
import unittest
from unittest.mock import patch
import rwa_eth_rpc

spec = util.spec_from_file_location("archive_rwa_chain", Path(__file__).with_name("archive-rwa-chain.py"))
archive = util.module_from_spec(spec)
spec.loader.exec_module(archive)
ADDRESS = next(iter(archive.ASSETS))
HEADER = {"number": 1, "hash": "0x" + "11" * 32, "timestamp": 1700000000}
EVENT = {"logIndex": 1, "address": ADDRESS, "topics": [archive.TRANSFER, "0x" + "00" * 32,
         "0x" + "00" * 12 + "12" * 20], "data": "0x" + "00" * 31 + "03", "transactionHash": "0x" + "01" * 32}


class ArchiveTests(unittest.TestCase):
    def test_boundaries_precision_and_log_index(self):
        row = archive.row_for(HEADER, EVENT)
        sample = archive.record_sample(row)
        self.assertEqual(sample["id"], f"1:{EVENT['transactionHash']}:1")
        self.assertEqual(sample["value"], "0.000000000000000003 PAXG")
        self.assertEqual(sample["label"], "PAXG · Mint")
        self.assertEqual(archive.format_amount(10**50+1, 6), str(10**44) + ".000001")

    def test_noncanonical_transfer_is_rejected(self):
        for e in [dict(EVENT, topics=EVENT["topics"] + [EVENT["data"]]), dict(EVENT, data="0x"),
                  dict(EVENT, topics=[archive.TRANSFER, "0x" + "ff" * 32, EVENT["topics"][2]])]:
            with self.assertRaises(ValueError):
                archive.row_for(HEADER, e)

    def test_partial_response_resumes_and_same_second_is_valid(self):
        block2 = dict(HEADER, number=2, hash="0x" + "22" * 32)
        with tempfile.TemporaryDirectory() as folder, patch.object(archive, "fetch_page", side_effect=[
                [{"header": HEADER, "logs": [EVENT]}], [{"header": block2}]]) as fetch:
            directory = Path(folder)
            part = archive.collect(directory, 1, 2)
            self.assertEqual([(args.args[1], args.args[2]) for args in fetch.call_args_list], [(1, 2), (2, 2)])
            out = archive.build_index(directory, [part], directory / "summary.json")
            self.assertEqual(out["count"], 1)
            self.assertEqual(out["byToken"], {"PAXG": 1})
            self.assertEqual(out["eventCounts"], {"mint": 1})

    def test_duplicate_tx_log_in_different_blocks_is_rejected_even_with_valid_digest(self):
        block2 = dict(HEADER, number=2, hash="0x" + "22" * 32, timestamp=HEADER["timestamp"] + 1)
        with tempfile.TemporaryDirectory() as folder, patch.object(archive, "fetch_page", return_value=[
                {"header": HEADER, "logs": [EVENT]}, {"header": block2, "logs": [EVENT]}]):
            directory = Path(folder)
            part = archive.collect(directory, 1, 2)
            with self.assertRaises(archive.sqlite3.IntegrityError):
                archive.build_index(directory, [part], directory / "summary.json")

    def test_duplicate_block_log_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(archive, "fetch_page", return_value=[
                {"header": HEADER, "logs": [EVENT, EVENT]}]):
            with self.assertRaises(ValueError):
                archive.collect(Path(folder), 1, 1)

    def test_alternative_receipts_deduplicate_and_reject_conflicts(self):
        meta = {"file": "part.csv.gz", "count": 3, "sha256": "example"}
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder)
            for directory, endpoint in [("verification", "https://portal.sqd.dev/datasets/ethereum-mainnet/stream"),
                                        ("verification-tenderly", "https://gateway.tenderly.co/public/mainnet")]:
                receipt = {"file": meta["file"], "sha256": meta["sha256"], "verifiedCount": 3, "reference": endpoint}
                (dest / directory).mkdir()
                filename = dest / directory / "part.csv.gz.json"
                filename.write_text(json.dumps(receipt))
            self.assertEqual(len(archive.verified_part(dest, meta)), 2)
            receipt["verifiedCount"] = 2
            filename.write_text(json.dumps(receipt))
            with self.assertRaisesRegex(ValueError, "Conflicting"):
                archive.verified_part(dest, meta)

    def test_rpc_keeps_complete_sparse_range_and_matches_boundary(self):
        event = dict(EVENT, blockNumber="0x2", blockHash="0x" + "22" * 32, blockTimestamp="0x6553f100",
                     logIndex=hex(EVENT["logIndex"]), removed=False)
        expected = [{"number": h, "timestamp": HEADER["timestamp"], "hash": "0x" + f"{h:02x}" * 32}
                    for h in [1, 3]]
        with patch.object(rwa_eth_rpc, "rpc", return_value=[event]), patch.object(rwa_eth_rpc, "header", side_effect=expected):
            blocks = rwa_eth_rpc.page(None, 1, 3, [ADDRESS], archive.TRANSFER, "https://example.org", 10000)
            self.assertEqual([b["header"]["number"] for b in blocks], [1, 2, 3])
            self.assertEqual(blocks[1]["logs"][0], EVENT)
            self.assertEqual(blocks[0]["logs"], [])

    def test_rpc_refuses_removed_log_and_changed_block_hash(self):
        event = dict(EVENT, blockNumber="0x1", blockHash=HEADER["hash"],
                     blockTimestamp=hex(HEADER["timestamp"]), logIndex="0x1", removed=True)
        with patch.object(rwa_eth_rpc, "rpc", return_value=[event]):
            with self.assertRaisesRegex(ValueError, "removed"):
                rwa_eth_rpc.page(None, 1, 2, [ADDRESS], archive.TRANSFER)
        event["removed"] = False
        wrong_header = dict(HEADER, hash="0x" + "33" * 32)
        with patch.object(rwa_eth_rpc, "rpc", return_value=[event]), patch.object(rwa_eth_rpc, "header", return_value=wrong_header):
            with self.assertRaisesRegex(ValueError, "mismatch"):
                rwa_eth_rpc.page(None, 1, 2, [ADDRESS], archive.TRANSFER)

    def test_corrupt_part_is_not_published(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(archive, "fetch_page", return_value=[
                {"header": HEADER, "logs": [EVENT]}]):
            directory = Path(folder)
            part = archive.collect(directory, 1, 1)
            with (directory / part["file"]).open("ab") as f:
                f.write(b"bad")
            with self.assertRaisesRegex(ValueError, "Digest"):
                archive.build_index(directory, [part], directory / "summary.json")
            self.assertFalse((directory / "summary.json").exists())


if __name__ == "__main__":
    unittest.main()
