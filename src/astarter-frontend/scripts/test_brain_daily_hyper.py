"""Offline regression checks for the native HyperCore sample adapter."""
import gzip
import json
import tempfile
import unittest
from datetime import date, timezone, datetime
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

import lz4.frame
import msgpack
import brain_daily_hyper as archive


class HyperCoreTests(unittest.TestCase):
    @staticmethod
    def wire(blocks):
        return lz4.frame.compress(msgpack.packb(blocks, use_bin_type=True))

    def test_explorer_counts_actions_inside_each_bundle(self):
        stamp = '2026-10-28T05:49:29.696004330'
        blocks = [{'header':{'height':101,'block_time':stamp},'txs':[]},
                  {'txs':[{'actions':[{'type':'order','orders':[1,2]}, {'type':'cancel'}]},
                          {'user':'x','actions':[{'type':'noop'}]}], 'header':{'height':102,'block_time':stamp}}]
        rows = archive.decode_source(self.wire(blocks), 200)
        self.assertEqual([(h,n) for h,_,n in rows], [(101,0),(102,3)])
        self.assertEqual(rows[0][1], int(datetime(2026,10,28,5,49,29,tzinfo=timezone.utc).timestamp()))

    def test_rejects_missing_actions_wrong_height_and_unknown_timestamp(self):
        for txs, h, ts in (([{}], 2, '2026-01-01T01:01:01'), ([], 0, '2026-01-01T01:01:01'),
                           ([], 2, None)):
            with self.subTest(h=h,ts=ts), self.assertRaises((ValueError, AttributeError, TypeError)):
                archive.decode_source(self.wire([{'header':{'height':h,'block_time':ts},'txs':txs}]),100)

    def test_source_object_partition_boundary(self):
        self.assertTrue(archive.object_key(100_000_000).endswith('/0/99900000/100000000.rmp.lz4'))
        self.assertTrue(archive.object_key(100_000_100).endswith('/100000000/100000000/100000100.rmp.lz4'))

    def test_filter_at_utc_boundary_and_replay_digest(self):
        day = date(2026,1,2)
        midnight = (day-archive.EPOCH).days*86400
        rows = [(401,midnight-1,2),(402,midnight,0),(403,midnight+1,25)]
        obj = (500,(rows,{'url':'https://sample','bytes':65,'etag':'ca'*16}))
        with tempfile.TemporaryDirectory() as td:
            dest=Path(td)/'out';receipts=Path(td)/'receipts'
            with patch.object(archive,'nearest_object',return_value=obj):
                first=archive.shard_for(day,[(midnight,500)],dest,receipts)
            raw=(dest/first['file']).read_bytes()
            self.assertEqual(first['count'],2)
            self.assertEqual(sha256(raw).hexdigest(),first['sha256'])
            self.assertEqual(json.loads(gzip.decompress(raw)),[402,midnight,[0,0,0,1,1,25]])
            with patch.object(archive,'nearest_object',side_effect=AssertionError('Unexpected fetch')):
                self.assertEqual(archive.shard_for(day,[],dest,receipts),first)
            (dest/first['file']).write_bytes(b'old')
            with patch.object(archive,'nearest_object',return_value=obj):
                self.assertEqual(archive.shard_for(day,[(midnight,500)],dest,receipts),first)

    def test_missing_days_are_not_filled_or_counted(self):
        a={'start':'2026-01-01','end':'2026-01-01','firstHeight':101,'lastHeight':200,'count':100}
        b={'start':'2026-01-03','end':'2026-01-03','firstHeight':801,'lastHeight':809,'count':9}
        series=archive.dataset([b,a])
        self.assertEqual(series['coverageMode'],'sampled')
        self.assertEqual(series['count'],109)
        self.assertEqual(len(series['ranges']),2)
        with self.assertRaises(ValueError):
            archive.dataset([a,{**b,'firstHeight':199}])

    def test_reject_open_day_or_other_network(self):
        for asset,previous,until in [('HYPE',None,datetime.now(timezone.utc).date()),
                                     ('HYPE',{'asset':'HYPE','network':'HyperEVM'},date(2020,1,1)),
                                     ('ETH',None,date(2020,1,1))]:
            with self.subTest(asset=asset,previous=previous), self.assertRaises(ValueError):
                archive.update_chain(asset,previous,Path('.'),until)


if __name__=='__main__':
    unittest.main()
