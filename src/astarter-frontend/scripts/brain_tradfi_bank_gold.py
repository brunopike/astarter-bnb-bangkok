"""Read Bank of Taiwan's published end-of-business gold passbook quotes."""
import csv
from datetime import date, datetime
import hashlib
import io
import json
import re


DATASET = "https://data.gov.tw/api/v2/rest/dataset/26404"
CACHE = "https://quality.data.gov.tw/dq_download_csv.php"
BID = "本行買入價格(新臺幣)"
ASK = "本行賣出價格(新臺幣)"


def quotes(until, load):
    dataset = json.loads(load(DATASET))["result"]
    if dataset["datasetId"] != 26404 or str(dataset["license"]) != "1":
        raise ValueError("Unexpected Bank of Taiwan dataset or license")
    history = {}
    for file in dataset["distribution"]:
        url = file["resourceDownloadUrl"]
        match = re.fullmatch(r"https://www\.bot\.com\.tw/Govinfo/opendata/csv/233/(\d{3})GoldPassbook\.csv", url)
        if not match:
            raise ValueError("Unexpected gold passbook file: " + url)
        vintage = 1911 + int(match[1])
        if vintage < 2016 or vintage > until.year:
            continue
        file_id = hashlib.md5(url.encode(), usedforsecurity=False).hexdigest()
        content = load(CACHE, {"nid": "26404", "md5_url": file_id})
        reader = csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
        if not {"日期", BID, ASK}.issubset(reader.fieldnames or []):
            raise ValueError("Unexpected gold quote columns")
        seen = set()
        for row in reader:
            day = datetime.strptime(row["日期"], "%Y%m%d").date()
            if day in seen or not date(vintage, 1, 1) <= day <= date(vintage+1, 1, 10):
                raise ValueError("Duplicate or unexpected gold quote date")
            seen.add(day)
            if row.get("商品重量", "1公克") != "1公克" or row.get("牌價幣別", "新台幣(TWD)") != "新台幣(TWD)":
                raise ValueError("Unexpected gold weight or currency")
            bid, ask = int(row[BID]), int(row[ASK])
            if not 0 < bid <= ask:
                raise ValueError("Invalid bank bid/ask spread")
            # The annual files can overlap in early January. Prefer the edition for that year.
            if day <= until and (day not in history or vintage > history[day][0]):
                history[day] = (vintage, bid, ask)
        if not seen or len(seen) != int(file["resourceAmount"]):
            raise ValueError("Incomplete gold passbook annual file")
    if not history:
        raise ValueError("No bank gold quotes")
    meta = {
        "id": "bot-gold-passbook", "group": "metals", "zh": "台湾银行黄金存折 · 营业日买卖牌价",
        "en": "Bank of Taiwan gold passbook · closing bid and ask", "unit": "TWD/g",
        "statistic": "bankBidAsk", "frequency": "daily", "fields": ["date", "bid", "ask"],
        "source": "Bank of Taiwan", "sourceUrl": "https://data.gov.tw/dataset/26404",
        "license": "Taiwan Open Government Data License 1.0", "licenseUrl": "https://data.gov.tw/license",
        "coverage": "One quote pair per gram at the end of business. Daily observations are released in annual files. The newer annual edition prevails on overlapping dates.",
    }
    yield meta, [[day.isoformat(), *history[day][1:]] for day in sorted(history)]
