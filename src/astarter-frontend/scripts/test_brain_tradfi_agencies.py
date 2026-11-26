"""Check exact publisher series, date semantics and units for the five agency sources."""

from io import BytesIO
import unittest
from unittest.mock import Mock, patch
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import xlrd
from xlrd.sheet import Cell

import brain_tradfi_agencies as agency


def make_series(code, observations):
    release, name, description, tenor = agency.FED_SERIES[code]
    namespace = "{http://www.federalreserve.gov/structure/compact/" + release + "_" + release + "}"
    attrs = {"SERIES_NAME": name, "FREQ": "9", "UNIT_MULT": "1"}
    if release == "H10":
        attrs.update(FX=tenor, UNIT="Index:_1997_Jan_100")
    else:
        attrs.update(MATURITY=tenor, INSTRUMENT="TCMNOM", UNIT="Percent:_Per_Year")
    node = ET.Element(namespace + "Series", attrs)
    ET.SubElement(node, agency.ANNOTATION + "AnnotationText").text = description
    for day, status, amount in observations:
        ET.SubElement(node, agency.FED_COMMON + "Obs", TIME_PERIOD=day, OBS_STATUS=status, OBS_VALUE=str(amount))
    return node


def package(release, nodes):
    doc = ET.Element("root")
    doc.extend(nodes)
    buf = BytesIO()
    with ZipFile(buf, "w") as zf:
        zf.writestr(release + "_data.xml", ET.tostring(doc))
    return buf.getvalue()


def oil_book(key="RWTC", title="Cushing, OK WTI Spot Price FOB (Dollars per Barrel)", prices=None):
    headers = [["Sourcekey", key], ["Date", title]]
    if prices is None:
        prices = [(43941, Cell(xlrd.XL_CELL_NUMBER, -36.98)), (43942, Cell(xlrd.XL_CELL_EMPTY, ""))]
    sheet = Mock(ncols=2, nrows=len(prices) + 3)
    sheet.row_values.side_effect = lambda i: headers[i - 1]
    sheet.row.side_effect = lambda i: (Cell(xlrd.XL_CELL_DATE, prices[i - 3][0]), prices[i - 3][1])
    book = Mock(datemode=0)
    book.sheet_by_name.return_value = sheet
    return book


class AgencyTests(unittest.TestCase):
    def test_yields_share_one_download_keep_valid_days_only(self):
        values = [("2026-11-23", "ND", -9999), ("2026-11-24", "A", 4.63)]
        two = make_series("DGS2", values)
        ten = make_series("DGS10", [("2026-11-24", "A", 4.91)])
        agency._fed_release.cache_clear()
        self.addCleanup(agency._fed_release.cache_clear)
        with patch.object(agency, "_download", return_value=package("H15", [two, ten])) as get:
            self.assertEqual(agency.fetch_agency("DGS2")[1], [["2026-11-24", 4.63]])
            self.assertEqual(agency.fetch_agency("DGS10")[1], [["2026-11-24", 4.91]])
            get.assert_called_once_with("https://www.federalreserve.gov/releases/h15/data/FRB_h15_xml.zip")

    def test_yields_reject_wrong_frequency_unit_maturity_and_missing_series(self):
        values = [("2026-11-24", "A", 4)]
        for field, wrong in [("FREQ", "1"), ("UNIT_MULT", "100"), ("UNIT", "basis points"), ("MATURITY", "Y10")]:
            node = make_series("DGS2", values)
            node.set(field, wrong)
            with self.subTest(field=field), self.assertRaises(ValueError):
                agency._fed_rows(node, "DGS2")
        with self.assertRaises(ValueError):
            agency._parse_fed(package("H15", [make_series("DGS2", values)]), "H15")

    def test_dollar_base_and_identity_are_checked_independently(self):
        values = [(f"2006-01-{day:02d}", "A", 99.5 if day % 2 else 100.5) for day in range(2, 22)]
        node = make_series("DTWEXBGS", values)
        self.assertEqual(len(agency._parse_fed(package("H10", [node]), "H10")["DTWEXBGS"]), 20)
        node.set("SERIES_NAME", "JRXWTFO_N.B")
        with self.assertRaises(ValueError):
            agency._parse_fed(package("H10", [node]), "H10")
        for wrong in ([(d, status, v + 0.1) for d, status, v in values], values[:10]):
            with self.assertRaises(ValueError):
                agency._fed_rows(make_series("DTWEXBGS", wrong), "DTWEXBGS")

    def test_real_dates_order_and_missing_sentinels(self):
        for rows in [
            [("2026-02-30", "A", 1)], [("2026-02-20", "A", 1)] * 2,
            [("2026-02-20", "A", -9999)], [("2026-02-20", "A", "nan")],
            [("2026-02-20", "unknown", 0)], [("2026-02-20", "ND", -9999)],
        ]:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                agency._fed_rows(make_series("DGS2", rows), "DGS2")

    def test_oil_units_series_and_negative_spot(self):
        self.assertEqual(agency._oil_rows(oil_book(), "DCOILWTICO"), [["2020-04-20", -36.98]])
        for workbook in [
            oil_book(key="RBRTE"), oil_book(title="WTI futures (USD contracts)"),
            oil_book(prices=[(43941.5, Cell(xlrd.XL_CELL_NUMBER, 30.0))]),
            oil_book(prices=[(43941, Cell(xlrd.XL_CELL_TEXT, "bad price"))]),
        ]:
            with self.assertRaises(ValueError):
                agency._oil_rows(workbook, "DCOILWTICO")
        brent = oil_book("RBRTE", "Europe Brent Spot Price FOB (Dollars per Barrel)",
                         [(43941, Cell(xlrd.XL_CELL_NUMBER, 17.36))])
        self.assertEqual(agency._oil_rows(brent, "DCOILBRENTEU"), [["2020-04-20", 17.36]])


if __name__ == "__main__":
    unittest.main()
