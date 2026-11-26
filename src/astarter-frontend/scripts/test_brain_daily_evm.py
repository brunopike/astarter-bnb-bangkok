import json
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import brain_daily_evm as m


class CompletedPartitionTests(unittest.TestCase):
    day = date(2020, 11, 25)

    def test_daily_listing_ignores_intraday_files_and_keeps_publication_time(self):
        key = 'v1.0/btc/blocks/date=2020-11-25/'
        keys = [key+'977500.snappy.parquet', key+'part-00000-abcdef-c000.snappy.parquet']
        xml = '<ListBucketResult>'+''.join(
            f'<Contents><Key>{k}</Key><ETag>{32*"a"}</ETag><Size>123</Size>'
            '<LastModified>2020-11-26T00:30:00.000Z</LastModified></Contents>' for k in keys)+'</ListBucketResult>'
        http = MagicMock()
        http.get.return_value.content = xml.encode()
        with patch.object(m.archive, 'session', return_value=http):
            parts = m.list_days('BTC', self.day, self.day)[self.day]
            self.assertEqual(len(parts), 1)
            self.assertEqual(parts[0]['lastModified'], '2020-11-26T00:30:00.000Z')
            self.assertTrue(parts[0]['url'].endswith(keys[1]))
            http.get.return_value.content = xml.replace('11-26T', '11-25T').encode()
            with self.assertRaises(m.IncompleteDay):
                m.list_days('BTC', self.day, self.day)

    def test_current_utc_day_is_not_loaded(self):
        today = datetime.now(timezone.utc).date()
        prior = {'asset': 'BNB', 'end': (today-timedelta(days=1)).isoformat()}
        with patch.object(m, 'list_days') as listing:
            self.assertIs(m.update_chain('BNB', prior, Path('.'), today), prior)
            listing.assert_not_called()

    def test_gaps_stop_append_without_modifying_prior(self):
        prior = {'asset': 'ETH', 'end': '2020-11-22'}
        with patch.object(m, 'list_days', return_value={self.day: ['source']}):
            with self.assertRaisesRegex(m.IncompleteDay, '2020-11-23'):
                m.update_chain('ETH', prior, Path('.'), self.day)
        self.assertEqual(prior, {'asset': 'ETH', 'end': '2020-11-22'})

    def test_backlog_keeps_completed_prefix_while_last_export_is_pending(self):
        prior = {'asset':'ETH', 'end':'2020-11-22', 'shards':[{'lastHeight': 5}],
                 'ranges':[{'start':'2020-11-22','end':'2020-11-22','count':1}]}
        prior['shards'][0].update(start='2020-11-22',end='2020-11-22',count=1)
        first = date(2020,11,23)
        sh = {'firstHeight':6,'lastHeight':7,'count':2,'start':str(first),'end':str(first)}
        with tempfile.TemporaryDirectory() as folder, patch.object(
                m, 'list_days', return_value={first:['source']}), patch.object(
                m, 'capture', return_value=sh), patch.object(m, 'check_evm_edges'):
            result = m.update_chain('ETH', prior, Path(folder), self.day)
            self.assertEqual(result['end'], str(first))
            self.assertEqual(result['count'], 3)

    def test_projected_bnb_parquet_matches_raw_rows_and_checks_utc(self):
        stamp = m.day_start(self.day)
        table = m.archive.pa.table({'number':[8,9,10,11], 'extra':['a'*30000]*4,
                                    'timestamp':[stamp,stamp,stamp+1,stamp+2],
                                    'transaction_count':[0,1,2,3]})
        sink = m.archive.pa.BufferOutputStream()
        m.archive.parquet.write_table(table,sink,row_group_size=1)
        raw = sink.getvalue().to_pybytes()
        source = {'url':'https://example.org/blocks.parquet','bytes':len(raw),'etag':'a'*32}
        http = MagicMock()
        def respond(url, headers, timeout):
            self.assertEqual(headers['If-Match'], '"'+source['etag']+'"')
            a,b = map(int, headers['Range'].split('=')[1].split('-'))
            response = MagicMock(status_code=206,content=raw[a:b+1])
            response.headers = {'ETag':headers['If-Match'], 'Content-Range':f'bytes {a}-{b}/{len(raw)}'}
            return response
        http.get.side_effect=respond
        with patch.object(m.archive,'session',return_value=http):
            rows=m.extract_bnb([source],self.day)
            self.assertEqual(rows,[(8,stamp,0),(9,stamp,1),(10,stamp+1,2),(11,stamp+2,3)])
            with self.assertRaises(m.IncompleteDay):
                m.extract_bnb([source], self.day-timedelta(days=1))

    def test_non_monotone_evm_chain_fails(self):
        ts = m.day_start(self.day)
        with tempfile.TemporaryDirectory() as folder, patch.object(
                m, 'extract_bnb', return_value=[[40,ts+4,1],[41,ts+3,2]]):
            with self.assertRaises(m.IncompleteDay):
                m.capture('BNB', self.day, [], Path(folder))
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_complete_evm_day_needs_true_predecessor_and_successor(self):
        ts = m.day_start(self.day)
        def shard():
            return {'start': str(self.day), 'end': str(self.day), 'firstHeight': 5,
                    'lastHeight': 8, 'count': 4}
        with patch.object(m, 'eth_header', side_effect=[{'timestamp':ts-1},{'timestamp':ts+86400}]):
            complete = shard()
            m.check_evm_edges('ETH', [complete], {'lastHeight':4})
            self.assertEqual(complete['dayEndSuccessor']['timestamp'], ts+86400)
        with patch.object(m, 'eth_header', side_effect=[{'timestamp':ts-1},{'timestamp':ts+86399}]):
            with self.assertRaisesRegex(m.IncompleteDay, 'later'):
                m.check_evm_edges('ETH', [shard()], None)
        with patch.object(m, 'eth_header', return_value={'timestamp':ts}):
            with self.assertRaisesRegex(m.IncompleteDay, 'earlier'):
                m.check_evm_edges('ETH', [shard()], None)
        with self.assertRaisesRegex(m.IncompleteDay, 'discontinuity'):
            m.check_evm_edges('BNB', [shard()], {'lastHeight':3})

    def test_non_monotone_bitcoin_clock_may_cross_midnight_and_return(self):
        ts = m.day_start(self.day)
        stamps = {20:ts+500, 21:ts-5, 22:ts+25, 23:ts+86403}
        def headers(ending):
            return {h:{'height':h,'timestamp':stamps.get(h, ts-100 if h<20 else ts+86405),
                       'medianTime':ts+86401 if h>=28 else ts-20} for h in range(ending-14,ending+1)}
        rows = [[20,ts+500,1],[22,ts+25,2]]
        with patch.object(m, 'btc_window', side_effect=headers):
            self.assertEqual(m.verify_btc(self.day, rows, 21)['height'],28)
            stamps[21] = ts+3
            with self.assertRaisesRegex(m.IncompleteDay, '21'):
                m.verify_btc(self.day, rows, 19)
            stamps[21], stamps[25] = ts-5, ts+100
            with self.assertRaisesRegex(m.IncompleteDay, '25'):
                m.verify_btc(self.day, rows, 19)

    def test_multiday_bitcoin_reconciles_interior_heights_and_only_calls_explorer_at_edges(self):
        first = self.day-timedelta(days=2)
        dates = [first+timedelta(days=i) for i in range(3)]
        before = (first-timedelta(days=1)).isoformat()
        prior = m.combine('BTC',None,[{'start':before,'end':before,'count':1,'lastHeight':9}])
        heights = [10,11,12]
        def fetch(sources, day):
            return [[heights[dates.index(day)], m.day_start(day), 3]]
        with tempfile.TemporaryDirectory() as folder, patch.object(
                m, 'list_days', return_value={day:['source'] for day in dates}), patch.object(
                m.archive,'extract',side_effect=fetch), patch.object(m,'verify_btc',return_value={'height':60}) as check:
            result = m.update_chain('BTC',prior,Path(folder),self.day)
            self.assertEqual(result['count'],4)
            self.assertEqual([c.args[0] for c in check.call_args_list],[dates[0],dates[-1]])
            self.assertEqual([c.args[2] for c in check.call_args_list],[9,11])
        heights[:] = [10,12,13]
        with tempfile.TemporaryDirectory() as folder, patch.object(
                m, 'list_days', return_value={day:['source'] for day in dates}), patch.object(
                m.archive,'extract',side_effect=fetch), patch.object(m,'verify_btc') as check:
            with self.assertRaisesRegex(ValueError, 'Missing interior Bitcoin'):
                m.update_chain('BTC',prior,Path(folder),self.day)
            check.assert_not_called()

    def test_existing_shard_is_immutable_even_after_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'eth-date.json.gz'
            m.write_once(path,b'first')
            m.write_once(path,b'first')
            with self.assertRaisesRegex(ValueError, 'immutable'):
                m.write_once(path,b'second')
            self.assertEqual(path.read_bytes(),b'first')
            self.assertEqual(list(Path(folder).iterdir()),[path])

    def test_stats_are_additive_and_previous_references_are_intact(self):
        def shard(day):
            return {'start':day,'end':day,'count':3}
        initial = m.combine('ETH', None, [shard('2020-11-23')])
        snapshot = json.dumps(initial)
        result = m.combine('ETH', initial, [shard('2020-11-24'),shard('2020-11-25')])
        self.assertEqual(json.dumps(initial),snapshot)
        self.assertEqual(result['count'],9)
        self.assertEqual(result['ranges'],[{'start':'2020-11-23','end':'2020-11-25','count':9}])


if __name__ == '__main__':
    unittest.main()
