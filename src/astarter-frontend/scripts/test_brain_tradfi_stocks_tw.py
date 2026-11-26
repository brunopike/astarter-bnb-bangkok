import json
from datetime import date
from pathlib import Path
import tempfile
import unittest

from brain_tradfi_stocks_tw import LEGACY, bar, compile_market, mirror_day, recover_batch


class TaiwanStockTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dest=Path(self.temp.name)
        self.issuers={'twse':{'2330':('台積電','TSMC','1994-09-05'),'9999':('示例','Test','2026-05-05')},'tpex':{}}
        for ticker,code in LEGACY.items():
            rows=[['2026-05-04',104.0]] if ticker=='2330' else []
            (self.dest/(code+'.json')).write_text(json.dumps({'id':code,'rows':rows}))

    def quotes(self,when,rows):
        return ('twse',when,rows,'https://example.org/observations/'+when,'0'*64)

    def test_only_real_trades_and_issuer_dates_appear_once(self):
        prices={'2330':[101,105,100,104,20000],'9999':[5,5,5,5,10],'0050':[10,10,10,10,100]}
        incoming=[self.quotes('2026-05-04',prices), self.quotes('2026-05-05',prices)]
        result=compile_market(self.dest,date(2026,5,5),self.issuers,incoming)
        self.assertEqual((result['issuers'],result['rows'],result['existingCloseDatesOmitted']),(2,2,1))
        file=self.dest/'tw-stock-twse-2330.json'
        first=file.read_bytes()
        row=json.loads(first)['rows'][0]
        self.assertEqual(row,['2026-05-05',104,101,105,100,20000])
        self.assertFalse((self.dest/'tw-stock-twse-0050.json').exists())
        proof=self.dest/'tw-stock-sources.json'
        before=proof.read_bytes()
        self.assertEqual(json.loads(before)['ohlcvByIssuer']['2330']['2026-05-04'],[104,101,105,100,20000])
        compile_market(self.dest,date(2026,5,5),self.issuers,[])
        self.assertEqual(proof.read_bytes(),before)
        result=compile_market(self.dest,date(2026,5,5),self.issuers,incoming)
        self.assertEqual((result['rows'],file.read_bytes()),(2,first))
        compile_market(self.dest,date(2026,5,4),self.issuers,[self.quotes('2026-05-06',prices)])
        self.assertEqual(file.read_bytes(),first)

    def test_mismatched_old_close_and_conflicting_bars_preserve_prior_archive(self):
        first=self.quotes('2026-05-05',{'2330':[101,105,100,104,20000]})
        compile_market(self.dest,date(2026,5,5),self.issuers,[first])
        before=(self.dest/'catalog.json').read_bytes()
        for day in ['2026-05-04','2026-05-05']:
            with self.assertRaisesRegex(ValueError,'conflict|Conflicting'):
                compile_market(self.dest,date(2026,5,5),self.issuers,[self.quotes(day,{'2330':[100,106,99,105,20000]})])
            self.assertEqual((self.dest/'catalog.json').read_bytes(),before)

    def test_partial_day_is_never_a_complete_ohlcv(self):
        self.assertIsNone(bar([10,'---',10,10,1000]))
        self.assertIsNone(bar([10,10,10,10,0]))
        self.assertRaises(ValueError,bar,[101,99,98,100,200])
        self.assertRaises(ValueError,bar,[100,100,100,100,1.5])

    def test_market_receipt_requires_a_priced_issuer(self):
        empty=self.quotes('2026-05-05',{'0050':[10,10,10,10,500]})
        with self.assertRaisesRegex(ValueError,'No eligible issuer prices in twse'):
            compile_market(self.dest,date(2026,5,5),self.issuers,[empty])
        self.assertFalse((self.dest/'tw-stock-sources.json').exists())

    def test_mirror_checks_payload_and_origin(self):
        import hashlib
        rows={str(s):[10,10,10,10,1] for s in range(1000,1600)}
        docs={'schema':1,'kind':'price_twse','trade_date':'2026-11-24','source':'twse_openapi_stock_day_all',
              'license':'open','fields':['open','high','low','close','volume_shares'],'rows':rows}
        dig={k:docs[k] for k in ['rows','source','license']}
        docs['checksum']=hashlib.sha256(json.dumps(dig,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        def call():return mirror_day(json.dumps(docs).encode(),'twse','2026-11-24','0'*40)
        self.assertEqual(len(call()[2]),600)
        docs['rows']['1000'][0]=9
        self.assertRaises(ValueError,call)
        docs['rows']['1000'][0]=10;docs['source']='unknown'
        self.assertRaises(ValueError,call)

    def test_recover_pending_files_before_new_batch(self):
        pending=self.dest/'.tw-stock-pending';pending.mkdir()
        (pending/'catalog.json').write_text('{"version":1,"series":[]}')
        (pending/'tw-stock-sources.json').write_text('{"days":{}}')
        recover_batch(self.dest)
        self.assertFalse(pending.exists())
        self.assertEqual(json.loads((self.dest/'tw-stock-sources.json').read_text())['days'],{})


if __name__=='__main__': unittest.main()
