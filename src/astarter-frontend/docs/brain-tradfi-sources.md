# Public market archive sources

### U.S. stock and exchange-traded product activity

The [SEC MIDAS quarterly files](https://www.sec.gov/data-research/sec-markets-data/market-structure-data-security-exchange) report trading activity for individual securities and exchanges. One observation identifies a trading date, security type, ticker and venue. The public archive retains one copy of an identical observation and excludes observations with missing identifiers or conflicting values for the same key. It records source-file hashes, rejected rows and the date range for each quarter. The SEC publishes these statistics quarterly. The daily updater checks for additions and revisions. [SEC methodology](https://www.sec.gov/featured-topics/market-structure-analytics/market-activity-report-methodology) · [SEC reuse terms](https://www.sec.gov/about/privacy-information#dissemination)

The market browser provides a searchable quarterly ticker index. Each preview is an actual record from the ticker’s latest observed day in that quarter, selected from the venue with the most reported trades on that date. Volumes use the source unit of thousands of shares. The quarterly ZIP contains the full set of observations across dates and venues. The catalog counts underlying observations once. Ticker indexes, preview rows and duplicate copies of the source ZIP add zero to that count. [Full quarterly source files and checksums](https://github.com/brunopike/astarter-bnb-bangkok/releases/tag/tradfi-sec-midas)

The TradFi Markets total counts published observations. A daily OHLC or OHLCV row counts once. A wholesale quote counts once for its reporting key. A daily oracle read counts once for its feed, network and UTC date. The archive displays each category separately.

## Daily market records

| Collection | Published unit and coverage | Source and reuse |
| --- | --- | --- |
| WIKI US equities | Unadjusted stock OHLCV. Releases ended on March 27, 2018. Listing dates and gaps differ by ticker. | [Nasdaq Data Link WIKI, public domain](https://data.nasdaq.com/databases/WIKIP) |
| US share settlement disclosures | SEC half-month files report an outstanding undelivered share balance on a settlement date, with the publisher's previous closing price where available. Entries match both the security identifier and ticker. The two publication footer totals are independently reconciled for each file. | [SEC files and field definitions](https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data) · [SEC dissemination policy](https://www.sec.gov/about/privacy-information#dissemination) |
| Taiwan listed and OTC equities | Cash OHLCV on verified report dates for identified listed companies. Dates and available price history vary by exchange and company. | [TWSE](https://data.gov.tw/dataset/11549) · [TPEx](https://data.gov.tw/dataset/11371) · [license](https://data.gov.tw/license) |
| Bank of Taiwan gold | One end-of-business gold passbook bid and ask per gram, per date. The bank releases these paired quotes in annual files. | [Bank of Taiwan, official open dataset](https://data.gov.tw/dataset/26404) · [license](https://data.gov.tw/license) |
| French retail fuels | Each daily regional median uses one final reported price per station for that day and fuel. The archive records the number of contributing stations. | [Ministry of Economy and Finance](https://www.prix-carburants.gouv.fr/rubrique/opendata/) · [Open Licence](https://www.etalab.gouv.fr/licence-ouverte-open-licence/) |
| Australian natural gas | Sydney, Adelaide and Brisbane ex ante gas clearing prices in AUD/GJ by gas day. | [Australian Energy Market Operator](https://www.aemo.com.au/energy-systems/gas/short-term-trading-market-sttm/data-sttm/daily-sttm-reports) · [reuse policy](https://www.aemo.com.au/privacy-and-legal-notices/copyright-permissions) |
| TPEx spot gold | AU9901 and AU9902 daily executions, with dated quoted units and actual trading volume. Published highs, lows, last trades and volume-weighted prices count as one market observation per traded instrument and day. | [Official gold market release](https://data.gov.tw/dataset/32443) · [license](https://data.gov.tw/license) |
| TAIEX | Cash index OHLC on published exchange days. | [Taiwan open data](https://data.gov.tw/dataset/11755) · [license](https://data.gov.tw/license) |
| TAIFEX | Nearest eligible traded expiry for each product. Each bar records the actual expiry and session volumes. Contracts have individual listing dates, currency and units. | [Taiwan Futures Exchange](https://www.taifex.com.tw/enl/eng3/futDataDown) · [government data](https://data.gov.tw/dataset/11319) · [license](https://data.gov.tw/license) |
| FX and precious metals | ECB currency reference rates and NBU accounting values per troy ounce retain their published currency and observation dates. | [ECB usage policy](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html) · [National Bank of Ukraine open data](https://bank.gov.ua/en/open-data) |
| Livestock, crude oil, rates and other series | USDA wholesale estimates, EIA spot assessments, Federal Reserve time series, SEC filings and World Bank monthly estimates retain their publication frequency. Each catalog entry identifies the release. | [USDA Market News](https://mpr.datamart.ams.usda.gov/menu.htm) · [EIA](https://www.eia.gov/petroleum/) · [Federal Reserve](https://www.federalreserve.gov/data.htm) · [World Bank Commodity Markets](https://www.worldbank.org/en/research/commodity-markets) |
| On-chain oracles | Reads at the final block of the UTC date include the contract, network, block hash, round and feed update time. An unchanged, still-valid round can recur on successive dates. | [Chainlink Data Feeds](https://data.chain.link/) |

## Indian wholesale reports

Data provided by the Directorate of Marketing and Inspection, Department of Agriculture and Farmers Welfare, Government of India, through AGMARKNET. Licensed under the [Government Open Data License – India](https://www.data.gov.in/Godl). Astarter selects commodities, filters rows, checks identities and republishes compact monthly records.

The [variety and grade data](https://www.data.gov.in/resource/variety-wise-daily-market-prices-data-commodity) records the minimum, maximum and modal wholesale price in INR per quintal (100 kg). The historical input is [Manas Khandelwal’s transcription, version 134](https://www.kaggle.com/datasets/khandelwalmanas/daily-commodity-prices-india/versions/134). The archive key combines the arrival date, state, district, market, commodity, variety and grade. The importer excludes missing identities, nonpositive prices, price-order violations and conflicting duplicate keys. Months contain reported dates only.

Additional variety and grade reports come from [KrashiMitra](https://github.com/kunal-rajput-317/mandi-data), sourced from AGMARKNET / data.gov.in and redistributed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and the [public rolling OGD mirror](https://github.com/vivekg7/mandi/tree/data). Monthly indexes identify the source snapshots. Astarter filters, deduplicates and encodes their dated records.

The [AGMARKNET market monitoring report](https://agmarknet.gov.in/home) separately publishes the arrival-weighted mean of reported modal prices for a commodity at each market. The collector verifies the date in each export, columns, price unit, reporting status and published weighting formula. It re-reads recent reports to pick up late arrivals.

The frozen historical import selected 14,732,145 source rows across twenty commodities and retained 14,532,990 observations. Build the historical archive from the verified annual CSV files using Python with DuckDB and scripts/brain_tradfi_mandi.py. Daily collection uses the standard library and curl. The table gives the SHA-256 of each input CSV from the pinned snapshot.

| File | SHA-256 |
| --- | --- |
| 2016-mandi.csv | c531b53988127b141d98d92a19d19b30dc33bf7205a635ca1a217df7b9a35476 |
| 2017-mandi.csv | 281228d04da793356825dd2fe610346391c8c3aa99d2bb0498801257ff9535e2 |
| 2018-mandi.csv | 4cb606ef9923daf51ba5adf61032c3ca8c10ae05cf2a4526e678f06cec6a3eaa |
| 2019-mandi.csv | c7c981efdeb85754abcda769591e46349f1b0a4d98463c2841664c5760f716e6 |
| 2020-mandi.csv | f748d89703c3eaff02985684f6df27891be406f8094207f85113d04b2f1e4018 |
| 2021-mandi.csv | 32709b6652f18b4e86c0de1a8523a640c3b7fef8a0954c1d7a972a3a3f492c35 |
| 2022-mandi.csv | bca75203f780a71d0cf06cf8ea1b36c774ecc75a914c49dd00d5815f6c172126 |
| 2023-mandi.csv | 7f5a6ee607afe9731de0412862bd6e6dfe30079eacba3928432e2580136b95e1 |
| 2024-mandi.csv | 59794b7a4dad2fa5e3f1a116851b584368ca99ce44a9fe90b2638e8a5faf7a60 |
| 2025-mandi.csv | 0070d5c0fd8f95a2268420eaa3f9b712f74bbb179e8c09025c4f32d4999bb45a |
| 2026-mandi.csv | 881de61a36fbcd00cc992f0f98abf67e980a0011daea255383a596305f875da5 |
