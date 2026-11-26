"""Point-in-time and unit-change regression checks for Berkshire's original 13F reports."""

import json
import unittest
from datetime import date

import brain_tradfi_holdings as sec


class OriginalFilingTests(unittest.TestCase):
    accession = "0000950123-22-000001"

    def filing(self, filed, stock_type="SH", cover_total=32):
        def row(cusip, name, value, shares, right=""):
            return f"""<infoTable><cusip>{cusip}</cusip><nameOfIssuer>{name}</nameOfIssuer>
            <titleOfClass>COM</titleOfClass><value>{value}</value><putCall>{right}</putCall>
            <shrsOrPrnAmt><sshPrnamt>{shares}</sshPrnamt><sshPrnamtType>{stock_type}</sshPrnamtType></shrsOrPrnAmt></infoTable>"""

        table = (
            row("191216100", "COCA COLA CO", 10, 40)
            + row("191216100", "COCA COLA CO", 20, 60)
            + row("191216100", "COCA COLA CO", 1, 100, "CALL")
            + row("999999999", "COCA COLA CO", 1, 100)
        )
        return f"""<SEC-DOCUMENT>{self.accession}.txt
        FILED AS OF DATE: {filed.replace("-", "")}
        <DOCUMENT><TYPE>13F-HR
<FILENAME>primary.xml
<XML><edgarSubmission><cik>{sec.CIK}</cik><reportCalendarOrQuarter>12-31-2022</reportCalendarOrQuarter><tableEntryTotal>4</tableEntryTotal><tableValueTotal>{cover_total}</tableValueTotal></edgarSubmission></XML></DOCUMENT>
        <DOCUMENT><TYPE>INFORMATION TABLE
<FILENAME>info.xml
<XML><informationTable xmlns="http://www.sec.gov/test">{table}</informationTable></XML></DOCUMENT>""".encode()

    def test_unit_is_from_filing_date_and_options_are_excluded(self):
        for filed, multiple in (("2023-01-02", 1000), ("2023-01-03", 1)):
            rows = sec.original_table("2022-12-31", filed, self.accession, self.filing(filed))
            self.assertEqual(list(rows), ["191216100"])
            self.assertEqual(
                rows["191216100"][:7],
                [filed, 30 * multiple / 100, "2022-12-31", 30, multiple, 100, self.accession],
            )
            self.assertTrue(rows["191216100"][7].endswith("/info.xml"))

    def test_information_table_must_match_cover_and_report(self):
        raw = self.filing("2023-01-03")
        cases = (
            self.filing("2023-01-03", cover_total=34),
            self.filing("2023-01-03", stock_type="PRN"),
            raw.replace(b"COCA COLA CO", b"UNRELATED"),
            raw.replace(b"0001067983", b"0000000001"),
            raw.replace(b"12-31-2022", b"09-30-2022"),
            raw.replace(b"20230103", b"20230204"),
        )
        for candidate in cases:
            with self.assertRaises(ValueError):
                sec.original_table("2022-12-31", "2023-01-03", self.accession, candidate)

    def test_missing_holding_preserves_its_history_and_other_issuers_advance(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        periods = [
            ("2016-03-31", "2016-05-16", "0000950123-16-000001"),
            ("2016-06-30", "2016-08-15", "0000950123-16-000002"),
            ("2016-09-30", "2016-11-15", "0000950123-16-000003"),
        ]
        absent = "191216100"

        def records(period, filed, accession, raw):
            return {
                cusip: [filed, 20.0, period, 2, 1000, 100, accession, "https://www.sec.gov/"]
                for cusip in sec.SECURITIES
                if cusip != absent or period != "2016-06-30"
            }

        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(sec, "original_table", side_effect=records) as read,
        ):
            dest = Path(folder)
            with patch.object(sec, "quarterly_filings", return_value=periods[:2]):
                sec.build(dest, date(2016, 8, 15), lambda url: b"fixture")
                self.assertEqual(read.call_count, 2)
                sec.build(
                    dest, date(2016, 8, 15), lambda url: self.fail("Verified reports must be reused")
                )
            self.assertEqual(read.call_count, 2)
            cat = {x["id"]: x for x in json.loads((dest / "catalog.json").read_bytes())["series"]}
            self.assertEqual(cat["ko-13f-value"]["count"], 1)
            self.assertEqual(cat["ko-13f-value"]["end"], "2016-05-16")
            self.assertEqual(cat["axp-13f-value"]["count"], 2)
            self.assertEqual(cat["aapl-13f-value"]["count"], 2)
            self.assertEqual(cat["ko-13f-value"]["notDisclosed"], {periods[1][2]: list(periods[1][:2])})
            with patch.object(sec, "quarterly_filings", return_value=periods):
                sec.build(dest, date(2016, 11, 15), lambda url: b"fixture")
            self.assertEqual(read.call_count, 3)
            rows = json.loads((dest / "ko-13f-value.json").read_bytes())["rows"]
            self.assertEqual([r[2] for r in rows], ["2016-03-31", "2016-09-30"])

    def test_amendments_do_not_replace_original_or_move_availability_earlier(self):
        recent = {
            "form": ["13F-HR", "13F-HR/A", "13F-HR"],
            "reportDate": ["2016-03-31", "2016-03-31", "2016-06-30"],
            "filingDate": ["2016-05-16", "2016-07-01", "2016-08-15"],
            "accessionNumber": ["0000950123-16-000001", "0000950123-16-000002", "0000950123-16-000003"],
        }
        payload = {
            "cik": 1067983,
            "name": "BERKSHIRE HATHAWAY INC",
            "filings": {"recent": recent, "files": []},
        }
        load = lambda _: json.dumps(payload)
        expected = [("2016-03-31", "2016-05-16", "0000950123-16-000001")]
        self.assertEqual(sec.quarterly_filings(date(2016, 8, 14), load), expected)
        with self.assertRaises(ValueError):
            sec.quarterly_filings(date(2016, 5, 15), load)
        recent["reportDate"][2] = "2016-09-30"
        recent["filingDate"][2] = "2016-11-01"
        with self.assertRaisesRegex(ValueError, "Missing Berkshire quarterly filing"):
            sec.quarterly_filings(date(2016, 12, 1), load)


if __name__ == "__main__":
    unittest.main()
