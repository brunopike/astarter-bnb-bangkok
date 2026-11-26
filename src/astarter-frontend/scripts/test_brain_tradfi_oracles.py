import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import brain_tradfi_oracles as oracle


def words(*parts):
    return '0x'+''.join(f'{v:064x}' for v in parts)


class OracleDailyTests(unittest.TestCase):
    def test_later_day_can_read_the_same_round_without_changing_its_timestamp(self):
        answer=words(2**64+2,2255000000,8000,8600,2**64+2)
        r=oracle.unpack_price('2022-01-01',56,10000,'0x'+'b'*64,answer,words(8),8)
        self.assertEqual(r[1],22.55)
        self.assertEqual(r[4:], [8600,str(2**64+2)])
        self.assertIsNone(oracle.unpack_price('2022-01-20',56,8600+864000+1,'a',answer,words(8),8))

    def test_errors_and_missing_rounds_are_distinct(self):
        a=words(2**64+1,10**8,1,2,2**64+1)
        for inputs in [(a,words(18)),(a,'0x'),(words(1,10**8,9,8,1),words(8)),(words(1,10**8,1,11,1),words(8))]:
            with self.assertRaises(ValueError):
                oracle.unpack_price('2025-01-01',55,10,'h',*inputs,8)
        self.assertIsNone(oracle.unpack_price('2025-01-01',55,10,'h','0x','0x',8))
        self.assertIsNone(oracle.unpack_price('2025-01-01',55,10,'h',words(2**64,0,0,0,0),words(8),8))

    def test_boundary_selects_last_height_in_same_second(self):
        times=[1,1,2,3,6,7,7,7,8,9,10]
        def header(h):
            return {'result':{'timestamp':hex(times[h]),'number':hex(h),'hash':'0x'+f'{h:064x}'}}
        def fake(_,calls):
            return [header(int(params[0],16)) for _,params in calls]
        with patch.object(oracle,'rpc',side_effect=fake):
            for hint in (4,6,7,9):
                self.assertEqual(oracle.last_block('rpc',hint,7,header(hint),header(hint+1)),(7,7,'0x'+f'{7:064x}'))

    def test_multicall_decoding_preserves_individual_failures_and_empty_contracts(self):
        word=lambda v:f'{v:064x}'
        # The first tuple succeeds with 32 bytes; the second fails with an empty payload.
        raw='0x'+''.join(map(word,[32,2,64,192,1,64,32,8,0,64,0]))
        self.assertEqual(oracle.multicall_values(raw,2),[{'result':words(8)},{'error':{'message':'execution reverted','data':'0x'}}])
        with self.assertRaises(ValueError):
            oracle.multicall_values(raw[:-64],2)
        with self.assertRaises(ValueError):
            oracle.multicall_values(raw,3)

    def test_legacy_aggregate_checks_returned_height_and_byte_lengths(self):
        # aggregate(...) returns (blockNumber, bytes[]) on legacy mainnet deployments.
        raw=words(55,64,2,64,128,32,8,0)
        self.assertEqual(oracle.legacy_values(raw,55,2),[{'result':words(8)},{'result':'0x'}])
        for value,height in [(raw,56),(raw[:-8],55)]:
            with self.assertRaises(ValueError):
                oracle.legacy_values(value,height,2)

    def test_daily_planner_never_fills_with_month_ends_only(self):
        dates=oracle.ordered_dates(date(2023,1,1),date(2023,3,31),{'2023-03-31'})
        self.assertEqual(len(dates),89)
        self.assertEqual(dates[0],date(2023,3,30))
        self.assertIn(date(2023,1,3), dates)

    def test_partial_read_does_not_mark_day_as_completed(self):
        f=oracle.FEEDS['avax'][0];day=date(2026,2,1)
        with tempfile.TemporaryDirectory() as root:
            dest=Path(root)
            with patch.object(oracle,'FIRST_MONTH',{'avax':day}),patch.object(oracle,'checked_precision',return_value={f[-1].lower():18}),patch.object(oracle,'block_for',return_value=(55,100)):
                with patch.object(oracle,'sample_days',side_effect=RuntimeError('mock timeout')):
                    errors=oracle.update_network(dest,day,'avax',[f],dest/'catalog.json',{},1)
                    self.assertTrue(errors)
                    self.assertFalse((dest/'coverage-avax.json').exists())
                row=[str(day),4,55,'0x'+'b'*64,99,'42']
                with patch.object(oracle,'sample_days',return_value={str(day):{'copper':row}}):
                    self.assertEqual(oracle.update_network(dest,day,'avax',[f],dest/'catalog.json',{},1),[])
                    self.assertEqual(json.loads((dest/'coverage-avax.json').read_text())['dates'],[str(day)])
                    self.assertEqual(json.loads((dest/'oracle-copper.json').read_text())['rows'],[row])
                with patch.object(oracle,'sample_days',side_effect=AssertionError('duplicate read')):
                    self.assertEqual(oracle.update_network(dest,day,'avax',[f],dest/'catalog.json',{},1),[])


if __name__=='__main__':
    unittest.main()
