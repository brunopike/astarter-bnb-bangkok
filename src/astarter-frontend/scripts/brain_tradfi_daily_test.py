import csv
import io
import json
import unittest
from datetime import date
from zipfile import ZipFile

import brain_tradfi_daily as d


class DailyTests(unittest.TestCase):
    def test_ecb_independent_rates_only_and_missing_not_filled(self):
        text = io.StringIO()
        writer = csv.writer(text)
        writer.writerow(["Date", *d.FX])
        for day, rate in [
            ("2016-01-06", "N/A"),
            ("2016-01-05", "2.5"),
            ("2016-01-04", "2.4"),
        ]:
            writer.writerow([day, *[rate if c == "BRL" else "N/A" for c in d.FX]])
        buffer = io.BytesIO()
        with ZipFile(buffer, "w") as z:
            z.writestr("eurofxref-hist.csv", text.getvalue())
        fetched = list(d.ecb_quotes(date(2016, 1, 6), lambda _: buffer.getvalue()))
        self.assertEqual(len(fetched), 1)
        meta, rows = fetched[0]
        self.assertEqual((meta["id"], meta["unit"]), ("eurbrl", "BRL/EUR"))
        self.assertEqual(rows, [["2016-01-04", 2.4], ["2016-01-05", 2.5]])

    def test_metal_ounce_multiplier_and_weekend_carry(self):
        def records(_, args):
            name = args["valcode"].upper()
            return json.dumps(
                [
                    {
                        "cc": name,
                        "r030": d.METALS[name][0],
                        "group": "3",
                        "exchangedate": day,
                        "rate": units * price,
                        "units": units,
                        "rate_per_unit": price,
                        "calcdate": calc,
                    }
                    for day, units, price, calc in [
                        ("31.12.2015", 10, 19, ""),
                        ("01.01.2016", 10, 19, ""),
                        ("04.01.2016", 10, 21, ""),
                        ("05.01.2016", 1, 22, "04.01.2016"),
                        ("06.01.2016", 1, 22, "04.01.2016"),
                        ("07.01.2016", 1, 22, "06.01.2016"),
                    ]
                ]
            )

        result = list(d.nbu_metals(date(2016, 1, 7), records))
        self.assertEqual(len(result), 4)
        self.assertTrue(
            all(
                rows == [["2016-01-04", 21], ["2016-01-05", 22], ["2016-01-07", 22]]
                for _, rows in result
            )
        )

        def invalid(url, args):
            v = json.loads(records(url, args))
            v[0]["rate"] = 1
            return json.dumps(v)

        with self.assertRaises(ValueError):
            list(d.nbu_metals(date(2016, 1, 7), invalid))

    def test_twse_upgrades_existing_close_once_and_rejects_wrong_bar(self):
        csv_data = "日期,開盤指數,最高指數,最低指數,收盤指數\n1050104,105,107,101,103\n"
        meta, rows = next(
            d.taiex_bars(
                date(2016, 1, 31), lambda *_: csv_data.encode(), [["2016-01-04", 103]]
            )
        )
        self.assertEqual(meta["fields"], ["date", "close", "open", "high", "low"])
        self.assertEqual(rows, [["2016-01-04", 103, 105, 107, 101]])
        with self.assertRaises(ValueError):
            next(
                d.taiex_bars(
                    date(2016, 1, 31),
                    lambda *_: csv_data.replace("107", "102").encode(),
                    [],
                )
            )

    def test_usda_requires_a_complete_report_not_an_average_substitution(self):
        def truncated(*_):
            return json.dumps(
                {
                    "reportSection": "Current Cutout Values",
                    "results": [],
                    "stats": {"totalRows:": 8, "returnedRows:": 0},
                }
            )

        with self.assertRaises(ValueError):
            list(d.usda_reports(date(2016, 1, 31), truncated, {}))


if __name__ == "__main__":
    unittest.main()
