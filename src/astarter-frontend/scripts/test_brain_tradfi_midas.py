import csv
import datetime
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import brain_tradfi_midas as midas


def fixture(path, malformed=False):
    def observation(
        month,
        security="Stock",
        ticker="TEST",
        exchange="Nasdaq",
        trades="0",
        rank=1,
        day="04",
    ):
        row = dict.fromkeys(midas.SOURCE_FIELDS, "")
        row.update(
            Date=f"2016{month:02}{day}.0",
            Security=security,
            Ticker=ticker,
            Exchange=exchange,
            Trades=trades,
            McapRank=rank,
        )
        row["TradeVol('000)"] = "0"
        return row

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for m, name in enumerate(("jan16.csv", "feb16.csv", "mar16.csv"), 1):
            out = io.StringIO()
            writer = csv.DictWriter(out, fieldnames=midas.SOURCE_FIELDS)
            writer.writeheader()
            # Identical projection but different original rank must remain a conflicting identity.
            writer.writerows(
                [
                    observation(m),
                    observation(m),
                    observation(m, ticker="CLASH", rank=1),
                    observation(m, ticker="CLASH", rank=2),
                    observation(m, exchange=""),
                    observation(m, ticker="NULL", trades=""),
                    observation(m, "ETF", "FUND", "NYSE", "2", day="03"),
                    observation(m, "ETF", "FUND", "Arca", "0"),
                    observation(m, "ETF", "FUND", "NYSE", "0"),
                    observation(m, "ETF", "FUND", "Edge-A", ""),
                ]
            )
            if malformed:
                writer.writerow(observation(10))
            z.writestr(name, out.getvalue())
        z.writestr("README.txt", "Monthly securities data")


class MIDAS(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.source = self.dir / "test.zip"
        fixture(self.source)

    def tearDown(self):
        self.tmp.cleanup()

    def test_counts_and_representative(self):
        values = midas.scan_quarter("2016Q1", self.source)
        stock, etf = values["Stock"], values["ETF"]
        self.assertEqual(
            [
                stock[k]
                for k in (
                    "count",
                    "rawRows",
                    "conflictingRows",
                    "conflictingKeys",
                    "missingKeyRows",
                    "identicalDuplicateRows",
                )
            ],
            [6, 18, 6, 3, 3, 3],
        )
        self.assertEqual(len(stock["tickers"]), 2)
        self.assertEqual(stock["tickers"]["NULL"][3:], [None, None, None, None, 0])
        self.assertEqual(
            etf["tickers"]["FUND"],
            ["2016-03-04", "FUND", "Arca", 0, None, None, None, 0],
        )
        self.assertEqual(etf["count"], 12)
        self.assertEqual(
            [(m["start"], m["end"]) for m in etf["monthly"]][0],
            ("2016-01-03", "2016-01-04"),
        )

    def test_malformed_source(self):
        fixture(self.source, True)
        with self.assertRaisesRegex(ValueError, "trading date"):
            midas.scan_quarter("2016Q1", self.source)

    def test_official_href_and_ambiguous_source(self):
        index = '<a href="/files/old-v2.zip">2016 Q1</a><a href="/files/new.zip">2016 Q2</a>'
        self.assertEqual(
            midas.official_quarters(index, datetime.date(2016, 3, 31)),
            {"2016Q1": "https://www.sec.gov/files/old-v2.zip"},
        )
        with self.assertRaises(ValueError):
            midas.official_quarters(
                index.replace("/files/old-v2.zip", "https://other.example/file.zip"),
                datetime.date(2016, 3, 31),
            )

    def test_incremental_source_preservation(self):
        dest = self.dir / "out"
        href = "https://www.sec.gov/files/old-v2.zip"

        def existing_url(_):
            return f'<a href="{href}">2016 Q1</a>'

        def download(url, key, path):
            raw = self.source.read_bytes()
            path.write_bytes(raw)
            return {
                "quarter": key,
                "sha256": midas.digest(self.source),
                "etag": None,
                "lastModified": "date",
                "size": len(raw),
                "url": url,
            }

        args = (dest, datetime.date(2016, 3, 31))
        midas.build(
            *args, load=existing_url, changed=lambda u, p: p is None, download=download
        )
        catalog = json.loads((dest / "catalog.json").read_bytes())
        entry = next(s for s in catalog["series"] if s["id"] == "sec-midas-equities")
        self.assertEqual(entry["count"], 6)
        self.assertEqual(entry["quarterIndexes"][0]["count"], 2)
        self.assertEqual(
            entry["quarterIndexes"][0]["sha256"],
            midas.digest(dest / "sec-midas-equities-2016q1.json"),
        )

        def unnecessary(*args):
            self.fail("Unexpected download or reparse")

        midas.build(
            *args,
            load=existing_url,
            changed=lambda u, p: False,
            download=unnecessary,
            scan=unnecessary,
        )
        self.assertEqual(catalog, json.loads((dest / "catalog.json").read_bytes()))

        def bad(*args):
            raise ValueError("bad revision")

        with self.assertRaisesRegex(ValueError, "bad revision"):
            midas.build(
                *args, load=existing_url, changed=lambda u, p: True, download=bad
            )
        self.assertEqual(catalog, json.loads((dest / "catalog.json").read_bytes()))
        # The remote may have changed its validators without changing content.
        midas.build(
            *args,
            load=existing_url,
            changed=lambda u, p: True,
            download=download,
            scan=unnecessary,
        )
        self.assertEqual(catalog, json.loads((dest / "catalog.json").read_bytes()))


if __name__ == "__main__":
    unittest.main()
