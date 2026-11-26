import json
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch
import brain_tradfi as market
import brain_tradfi_oracles as oracle


class MarketHistory(unittest.TestCase):
    def test_non_finite_is_invalid_and_negative_oil_is_preserved(self):
        self.assertEqual(market.number('-36.98'),-36.98)
        with self.assertRaises(ValueError):
            market.number('NaN')

    def test_valid_catalog_survives_single_publisher_outage(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest=Path(tmp)
            orig={'version':1,'series':[{'id':'wti','end':'2020-04-20','count':1}]}
            market.save(dest/'catalog.json',orig)
            with patch.object(market,'SPECS',[next(s for s in market.SPECS if s[0]=='wti')]),patch.object(market,'world_bank',return_value=('https://example.test',{})),patch.object(market,'fetch_fred',side_effect=ValueError('offline')):
                with self.assertRaisesRegex(RuntimeError,'offline'):
                    market.build(dest,date(2020,4,21))
            self.assertEqual(json.loads((dest/'catalog.json').read_bytes()),orig)

    def test_oracle_prelaunch_and_temporary_revert_are_distinct(self):
        target=date(2026,2,28)
        at=int(datetime(2026,2,28,23,59,50,tzinfo=timezone.utc).timestamp())
        feed=oracle.FEEDS['ethereum'][0]
        calls=[]
        def simulate(code):
            def fake(url,batch):
                calls.append(batch)
                method=batch[0][0]
                if method=='eth_chainId':
                    return [{'result':'0x1'},{'result':{'hash':'0x'+'a'*64,'number':'0x37','timestamp':hex(at)}}]
                if method=='eth_getCode':
                    return [{'result':code}]
                return [{'error':{'message':'execution reverted'}}]
            return fake
        for code in ('0x','0x6000'):
            with patch.object(oracle,'FEEDS',{'ethereum':[feed]}),patch.object(oracle,'block_for',return_value=(55,at+9)),patch.object(oracle,'rpc',side_effect=simulate(code)):
                if code=='0x':
                    self.assertEqual(oracle.sample('ethereum',target,{feed[-1].lower():8}),{})
                else:
                    with self.assertRaisesRegex(RuntimeError,'execution reverted'):
                        oracle.sample('ethereum',target,{feed[-1].lower():8})
        self.assertTrue(any(c[0][0]=='eth_getCode' for c in calls))

if __name__=='__main__':
    unittest.main()
