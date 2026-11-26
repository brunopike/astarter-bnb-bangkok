import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from brain_market_summary import attach_market_provenance, summarize


class LinkedBarCategoryTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.day = '2026-11-26'
        self.full = self.entry('tw-stock-twse-2330', 'ohlcv', [['2026-11-25', 9, 9, 11, 9, 10]],
                               sourceIndex='tw-stock-sources.json')
        self.close = self.entry('tsmc', 'close', [['2026-11-24', 9], [self.day, 12]], ticker='2330')
        self.catalog = {'series': [self.close, self.full]}
        self.proof = {
            'days': {'twse-'+self.day: {'https://www.twse.com.tw/report': '0'*64}},
            'ohlcvByIssuer': {'2330': {self.day: [12, 10, 13, 9, 100]}},
        }
        self.store_proof()

    def entry(self, key, statistic, rows, **kwargs):
        raw=json.dumps({'id':key,'rows':rows}).encode()
        (self.root/(key+'.json')).write_bytes(raw)
        return dict(id=key,statistic=statistic,group='stock',count=len(rows),start=rows[0][0],end=rows[-1][0],
                    sha256=hashlib.sha256(raw).hexdigest(),**kwargs)

    def store_proof(self):
        (self.root/'tw-stock-sources.json').write_text(json.dumps(self.proof))

    def test_category_transfer_is_idempotent(self):
        for _ in range(2):
            result=attach_market_provenance(self.root,self.catalog)
            summary=summarize(json.dumps(result).encode())
            self.assertEqual((summary['count'],summary['dailyBars'],summary['otherObservations']),(3,2,1))
            self.assertEqual(summary['perGroup']['stock']['dailyBars'],2)
            self.assertEqual(self.close['linkedDailyBars'],1)
        self.proof['ohlcvByIssuer']={}
        self.store_proof()
        attach_market_provenance(self.root,self.catalog)
        self.assertNotIn('linkedDailyBars',self.close)

    def test_rejects_conflicting_close_missing_source_or_standalone_overlap(self):
        self.proof['ohlcvByIssuer']['2330'][self.day][0]=11
        self.store_proof()
        with self.assertRaisesRegex(ValueError,'price'):
            attach_market_provenance(self.root,self.catalog)
        self.proof['ohlcvByIssuer']['2330'][self.day][0]=12
        self.proof['days']={}
        self.store_proof()
        with self.assertRaisesRegex(ValueError,'date or source'):
            attach_market_provenance(self.root,self.catalog)
        self.proof['days']={'twse-'+self.day:{'https://www.twse.com.tw/report':'0'*64}}
        self.store_proof()
        self.catalog['series'][1]=self.entry(self.full['id'],'ohlcv',[[self.day,12,10,13,9,100]],
                                             sourceIndex='tw-stock-sources.json')
        with self.assertRaisesRegex(ValueError,'date or source'):
            attach_market_provenance(self.root,self.catalog)

    def test_invalid_category_cannot_absorb_other_records(self):
        for entry, value in [(self.full,1),(self.close,3),(self.close,True)]:
            entry['linkedDailyBars']=value
            with self.assertRaisesRegex(ValueError,'Invalid linked daily-bar count'):
                summarize(json.dumps(self.catalog).encode())
            entry.pop('linkedDailyBars')
