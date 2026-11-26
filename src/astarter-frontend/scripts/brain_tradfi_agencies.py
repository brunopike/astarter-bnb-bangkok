"""Read daily yields, the nominal broad dollar index and spot crude from their publishers."""

from datetime import date
from functools import lru_cache
from io import BytesIO
import math
from statistics import mean
import xml.etree.ElementTree as ET
from zipfile import ZipFile

import requests


FED_SERIES = {
    "DGS2": ("H15", "RIFLGFCY02_N.B", "2-year Treasury constant maturity", "Y2"),
    "DGS10": ("H15", "RIFLGFCY10_N.B", "10-year Treasury constant maturity", "Y10"),
    "DTWEXBGS": ("H10", "JRXWTFB_N.B", "Nominal Broad Dollar Index", "BRD"),
}
OIL_SERIES = {
    "DCOILWTICO": ("RWTC", "Cushing, OK WTI Spot Price FOB (Dollars per Barrel)"),
    "DCOILBRENTEU": ("RBRTE", "Europe Brent Spot Price FOB (Dollars per Barrel)"),
}
FED_URL = "https://www.federalreserve.gov/releases/"
EIA_URL = "https://www.eia.gov/dnav/pet/"
FED_COMMON = "{http://www.federalreserve.gov/structure/compact/common}"
ANNOTATION = "{http://www.SDMX.org/resources/SDMXML/schemas/v1_0/common}"


def _download(url):
    with requests.get(url, timeout=(6, 22)) as response:
        response.raise_for_status()
        return response.content


def _append(rows, day, value):
    if date.fromisoformat(day).isoformat() != day or (rows and day <= rows[-1][0]):
        raise ValueError("Observation dates must be unique ISO dates in ascending order")
    value = float(value)
    if not math.isfinite(value) or value == -9999:
        raise ValueError("Invalid published observation")
    rows.append([day, value])


def _fed_rows(series, code):
    release, name, description, classification = FED_SERIES[code]
    if series.get("FREQ") != "9" or series.get("UNIT_MULT") != "1":
        raise ValueError("Unexpected Federal Reserve frequency or multiplier for " + name)
    descriptions = {entry.text for entry in series.iter(ANNOTATION + "AnnotationText")}
    if description not in descriptions:
        raise ValueError("Unexpected Federal Reserve series description for " + name)
    if release == "H15":
        if (series.get("UNIT"), series.get("INSTRUMENT"), series.get("MATURITY")) != (
            "Percent:_Per_Year", "TCMNOM", classification
        ):
            raise ValueError("Unexpected Treasury rate unit, instrument or tenor")
    elif series.get("FX") != classification or series.get("UNIT") not in {
        "Index:_1997_Jan_100", "Index:_2006_Jan_100"
    }:
        raise ValueError("Unexpected broad dollar series or unit")

    rows = []
    for observation in series.iterfind(FED_COMMON + "Obs"):
        status = observation.attrib["OBS_STATUS"]
        if status == "ND":
            continue
        if status != "A":
            raise ValueError("Unrecognized Federal Reserve observation status " + status)
        _append(rows, observation.attrib["TIME_PERIOD"], observation.attrib["OBS_VALUE"])
    if not rows:
        raise ValueError("Empty Federal Reserve series " + name)
    if release == "H10":
        # The XML unit label still mentions 1997. The Board's June 2019 H.10
        # technical Q&A sets the monthly average for January 2006 to 100.
        base = [v for day, v in rows if day.startswith("2006-01-")]
        if len(base) < 20 or abs(mean(base) - 100.0) > 0.0001:
            raise ValueError("Broad dollar observations do not match their January 2006 base")
    return rows


def _parse_fed(payload, release):
    names = {item[1]: code for code, item in FED_SERIES.items() if item[0] == release}
    series_tag = "{http://www.federalreserve.gov/structure/compact/" + release + "_" + release + "}Series"
    result = {}
    with ZipFile(BytesIO(payload)) as archive, archive.open(release + "_data.xml") as source:
        for _, element in ET.iterparse(source, events=("end",)):
            if element.tag.rsplit("}", 1)[-1] != "Series":
                continue
            code = names.get(element.get("SERIES_NAME"))
            if code and element.tag == series_tag:
                if code in result:
                    raise ValueError("Duplicate Federal Reserve series " + code)
                result[code] = _fed_rows(element, code)
            element.clear()
    if result.keys() != set(names.values()):
        raise ValueError("Required series missing from " + release)
    return result


@lru_cache(maxsize=2)
def _fed_release(release):
    path = release.lower()
    return _parse_fed(_download(f"{FED_URL}{path}/data/FRB_{path}_xml.zip"), release)


def _oil_rows(workbook, code):
    import xlrd

    key, title = OIL_SERIES[code]
    sheet = workbook.sheet_by_name("Data 1")
    if (sheet.ncols != 2 or sheet.row_values(1) != ["Sourcekey", key]
            or sheet.row_values(2) != ["Date", title]):
        raise ValueError("Unexpected EIA workbook, series key or quotation unit")
    rows = []
    for index in range(3, sheet.nrows):
        day, price = sheet.row(index)
        if day.ctype != xlrd.XL_CELL_DATE:
            raise ValueError("Expected an Excel observation date for " + key)
        if price.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK) or (
                price.ctype == xlrd.XL_CELL_TEXT and price.value in ("", "NA", "W")):
            continue
        if price.ctype != xlrd.XL_CELL_NUMBER:
            raise ValueError("Unexpected EIA price cell for " + key)
        stamp = xlrd.xldate_as_datetime(day.value, workbook.datemode)
        if stamp.hour or stamp.minute or stamp.second or stamp.microsecond:
            raise ValueError("Expected a daily EIA observation")
        _append(rows, stamp.date().isoformat(), price.value)
    if not rows:
        raise ValueError("No dated EIA prices for " + key)
    return rows


def fetch_agency(code):
    """Return the official release page and observed [date, value] rows, oldest first."""
    if code in FED_SERIES:
        release = FED_SERIES[code][0]
        return FED_URL + release.lower() + "/", _fed_release(release)[code]
    import xlrd

    key = OIL_SERIES[code][0]
    page = EIA_URL + "hist/" + key + "d.htm"
    payload = _download(EIA_URL + "hist_xls/" + key + "d.xls")
    with xlrd.open_workbook(file_contents=payload, on_demand=True) as workbook:
        return page, _oil_rows(workbook, code)
