import json
import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

from brain_market_summary import summarize
from brain_tradfi_mandi import make_shard, save_index
from brain_tradfi_mandi_live import parse, save_month

SAMPLE = """Data Monitoring Report (25-11-2026)
Commodity Group,Commodity,State/UT,District,Market,Reporting Status,Modal Price,Price Unit,Arrival,Arrival Unit
Cereals,Wheat,MP,Indore,M1,Reported Markets,2500,Rs./Quintal,9.9,Metric Tonnes
Cereals,Wheat,MP,Indore,M1,Reported Markets,2500,Rs./Quintal,9.9,Metric Tonnes
Cereals,Wheat,MP,Indore,M2,Reported Markets,2501,Rs./Quintal,5,Metric Tonnes
Cereals,Wheat,MP,Indore,M2,Reported Markets,2502,Rs./Quintal,5,Metric Tonnes
Cereals,Wheat,MP,Indore,M3,Non-reported Markets,-,-,-,-
Cereals,Wheat,MP,Indore,M4,Reported Markets,50,Rs./Kg,2,Metric Tonnes
Weighted Average Price = sum of arrival times market price divided by total arrival
"""


class MandiTests(unittest.TestCase):
    def test_price_identity_and_report_completion(self):
        day = date(2026, 11, 25)
        self.assertEqual(
            parse(SAMPLE.encode(), day), {("wheat", ("MP", "Indore", "M1")): 2500}
        )
        with self.assertRaisesRegex(ValueError, "date"):
            parse(SAMPLE.encode(), date(2026, 11, 24))
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            parse(SAMPLE.split("Weighted Average Price")[0].encode(), day)

    def test_revisions_keep_dates_and_do_not_count_price_fields(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            loc = ("MP", "Indore", "M1")
            info = make_shard(
                root, "mandi-wheat", "2016-01", [(1, loc + ("v", "g"), 120, 100, 130)]
            )
            historical = save_index(root, "Wheat", [info])
            catalog = {historical["id"]: historical}
            first = {"wheat": {(24, loc): 2500, (25, loc): 2510}}
            save_month(root, catalog, "2026-11", first, {24, 25})
            changed = {"wheat": {(25, loc): 2520}}
            save_month(root, catalog, "2026-11", changed, {25})
            chunk = root / "mandi-modal-wheat-2026-11.json"
            self.assertEqual(
                json.loads(chunk.read_bytes())["rows"], [[24, 0, 2500], [25, 0, 2520]]
            )
            digest = catalog["mandi-modal-wheat"]["sha256"]
            save_month(root, catalog, "2026-11", changed, {25})
            self.assertEqual(catalog["mandi-modal-wheat"]["sha256"], digest)
            summary = summarize(json.dumps({"series": list(catalog.values())}).encode())
            self.assertEqual(
                (summary["wholesaleQuotes"], summary["dailyBars"], summary["count"]),
                (3, 0, 3),
            )
