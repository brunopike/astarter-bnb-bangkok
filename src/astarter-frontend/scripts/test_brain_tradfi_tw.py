from datetime import date
import json
from pathlib import Path
import tempfile
import unittest

from brain_tradfi_tw import build, parse_latest, parse_report, read_day


class OpenTwseTest(unittest.TestCase):
    def test_rank_csv_requires_exact_day_filename_row_date_and_close_column(self):
        day = '2016-01-04'
        name = 'attachment; filename="MI_INDEX20_20160104.csv"'
        payload = '日期,排名,證券代號,開盤價,收盤價\n20160104,6,2330,142.50,139.50\n'.encode()
        self.assertEqual(parse_report(day,'rank',payload,name), {'2330':139.5})
        for bad in [payload.replace(b'20160104',b'20160105'),
                    payload.replace('收盤價'.encode(),'最高價'.encode()), payload+payload.splitlines()[1]]:
            with self.assertRaises(ValueError):
                parse_report(day,'rank',bad,name)
        with self.assertRaises(ValueError):
            parse_report(day,'rank',payload,name.replace('20160104','20160105'))

    def test_suspended_close_and_rank_omissions_are_missing(self):
        early = lambda day, kind: {'1590': 80, '4958': None} if kind == 'foreign' else {'2317':70,'1590':83}
        self.assertEqual(read_day('2016-06-01',early), {'1590':[80,'foreign'], '2317':[70,'rank']})
        newer = lambda day, kind: {'2330':98,'2317':100,'1590':120} if kind == 'valuation' else {'4958':53}
        self.assertEqual(read_day('2017-04-13',newer)['4958'], [53,'foreign'])

    def test_resume_keeps_the_licensed_values_and_retries_partial_failed_day(self):
        cal = [['2016-01-04',8114],['2016-01-05',8075],['2017-04-13',9800]]
        stub = {
            '2016-01-04':{'2330':[139.5,'rank'],'2317':[77,'rank'],'1590':[90,'foreign'],'4958':[75,'foreign']},
            '2016-01-05':{'2317':[75,'rank'],'1590':[92,'foreign'],'4958':[71,'foreign']},
            '2017-04-13':{'2330':[100,'valuation'],'2317':[101,'valuation'],'1590':[102,'valuation'],'4958':[103,'valuation']},
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'taiex.json').write_text(json.dumps({'id':'taiex','rows':cal}))
            old = {'id':'tsmc','rows':[['2016-01-05',999]]}
            (root/'tsmc.json').write_text(json.dumps(old))
            (root/'catalog.json').write_text(json.dumps({'version':1,'series':[{'id':'tsmc'}]}))
            build(root,date(2016,1,5),cache_dir=root/'cache',fetch_day=stub.__getitem__)
            first_catalog = (root/'catalog.json').read_bytes()
            self.assertEqual(json.loads((root/'tsmc.json').read_bytes())['rows'], [['2016-01-04',139.5]])

            def failed_day(day):
                if day == '2017-04-13':
                    raise OSError('source down')
                return stub[day]

            with self.assertRaises(OSError):
                build(root,date(2017,4,13),cache_dir=root/'cache',fetch_day=failed_day)
            self.assertEqual(first_catalog,(root/'catalog.json').read_bytes())
            touched = []

            def fetch(day):
                touched.append(day)
                return stub[day]

            build(root,date(2017,4,13),cache_dir=root/'cache',fetch_day=fetch)
            self.assertEqual(set(touched),{'2016-01-05','2017-04-13'})
            cat = {m['id']:m for m in json.loads((root/'catalog.json').read_bytes())['series']}
            self.assertEqual(cat['tsmc']['count'],2)
            self.assertEqual(cat['airtac']['count'],3)
            self.assertEqual(cat['tsmc']['sourcePeriods'][-1],['2017-04-13','2017-04-13','valuation'])
            self.assertEqual(cat['tsmc']['checkedTradingDays'],3)
            self.assertEqual(cat['tsmc']['earlyCoverage']['method'],'top20-volume')

    def test_latest_openapi_uses_its_published_date_and_rejects_cross_day_quotes(self):
        first = dict(Code='2330', Date='1151125', ClosingPrice='2,150.00')
        suspended = dict(Code='2317', Date='1151125', ClosingPrice='--')
        self.assertEqual(parse_latest([first, suspended]), ('2026-11-25', {'2330':[2150, 'daily']}))
        with self.assertRaises(ValueError):
            parse_latest([first, {**suspended, 'Date':'1151126'}])

    def test_partial_history_resumes_and_later_holdings_survive_an_earlier_cutoff(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            days = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']
            (root/'taiex.json').write_text(json.dumps({'id':'taiex','rows':[[d,100] for d in days]}))
            data = {t:[100,'valuation'] for t in ('1590', '2317', '2330', '4958')}
            seen = []

            def blocked(day):
                seen.append(day)
                if len(seen)>1:
                    raise OSError('TWSE paused automated downloads (HTTP 428)')
                return data

            with self.assertRaisesRegex(OSError, '428'):
                build(root,date(2026,11,26),cache_dir=root/'cache',fetch_day=blocked)
            self.assertEqual(seen, ['2026-11-26','2026-11-23'])
            cat = json.loads((root/'catalog.json').read_bytes())['series'][0]
            self.assertEqual(cat['checkedTradingDays'],1)
            self.assertEqual(cat['coverageMode'],'sampled-trading-days')
            self.assertEqual(cat['checkedTradingRanges'],[['2026-11-26','2026-11-26']])
            before = (root/'catalog.json').read_bytes()
            build(root,date(2026,11,25),cache_dir=root/'cache',fetch_day=blocked)
            self.assertEqual((root/'catalog.json').read_bytes(),before)
            build(root,date(2026,11,26),cache_dir=root/'cache',fetch_day=lambda day:data)
            cat = json.loads((root/'catalog.json').read_bytes())['series'][0]
            self.assertEqual(cat['checkedTradingDays'],4)
            self.assertEqual(cat['coverageMode'],'reported-close')
            self.assertEqual(cat['checkedTradingRanges'],[['2026-11-23','2026-11-26']])


if __name__ == '__main__':
    unittest.main()
