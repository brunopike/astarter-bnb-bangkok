import json
import io
import tarfile
from datetime import date
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from brain_tradfi_mandi import make_shard,save_index,store
import brain_tradfi_mandi_recent as recent


class RecentMarketQuotes(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dest=Path(self.tmp.name)
        row=(1,('S','D','M','Red','FAQ'),30,20,40)
        shard=make_shard(self.dest,'mandi-maize','2026-04',[row])
        meta=save_index(self.dest,'Maize',[shard])
        store(self.dest/'catalog.json',{'version':1,'series':[meta]})
    def state(self,rows):
        return [{'state':'S','rows':rows}]
    def row(self,d='2026-11-25',grade='FAQ',modal=30):
        return ['D','M','Maize','Red',grade,d,20,40,modal,None,None]

    def test_preserves_history_and_uses_arrival_day(self):
        before=(self.dest/'mandi-maize-2026-04.json').read_bytes()
        rows=self.state([self.row(),self.row(grade=''),self.row(grade='Local'),
                         self.row('2026-11-26'),self.row(grade='FAQ',modal=30)])
        audit=recent.merge(self.dest,date(2026,11,25),'a'*40,rows)
        self.assertEqual(audit['added'],2)
        self.assertEqual(audit['incompleteIdentity'],1)
        self.assertEqual(audit['afterCutoff'],1)
        self.assertEqual(before,(self.dest/'mandi-maize-2026-04.json').read_bytes())
        file=json.loads((self.dest/'mandi-maize-2026-11.json').read_bytes())
        self.assertEqual(file['locations'],[['S','D','M','Red','FAQ'],['S','D','M','Red','Local']])
        self.assertEqual(file['rows'],[[25,0,30,20,40],[25,1,30,20,40]])
        cat=(self.dest/'catalog.json').read_bytes()
        self.assertEqual(json.loads(cat)['series'][0]['count'],3)
        self.assertEqual(recent.merge(self.dest,date(2026,11,25),'a'*40,rows).get('added',0),0)
        self.assertEqual(cat,(self.dest/'catalog.json').read_bytes())

    def test_disputed_prices_do_not_replace_prior_or_create_fake_values(self):
        rows=self.state([self.row('2026-04-01',modal=21),self.row(),self.row(modal=33),
                         self.row('2026-11-22',modal=42)])
        audit=recent.merge(self.dest,date(2026,11,26),'a'*40,rows)
        self.assertEqual(audit['disputedExistingPricePreserved'],1)
        self.assertFalse((self.dest/'mandi-maize-2026-11.json').exists())
        self.assertEqual(audit['conflictingSnapshotRows'],1)
        self.assertEqual(audit['invalidPrices'],1)

    def test_only_real_target_arrival_dates_determine_freshness(self):
        stale=self.row('2026-04-25')
        other=self.row('2026-11-26');other[2]='Rubber'
        with patch.object(recent,'download',return_value=('c'*40,self.state([stale,other]))):
            with self.assertRaisesRegex(ValueError,'stale: latest arrival 2026-04-25'):
                recent.build(self.dest,date(2026,11,26))
            audit=recent.build(self.dest,date(2026,11,26),'c'*40)
            self.assertEqual((audit['matches'],audit['latestObservation']),(1,'2026-04-25'))
        with patch.object(recent,'download',return_value=('c'*40,self.state([other]))):
            with self.assertRaisesRegex(ValueError,'No usable target'):
                recent.build(self.dest,date(2026,11,26),'c'*40)

    def test_dated_csv_archive_verifies_dates_and_retains_cc_attribution(self):
        rev='c'*40
        def archive_for(stamp):
            result=io.BytesIO()
            text=('date,state,district,market,commodity,variety,grade,min_price,max_price,modal_price\n'
                f'{stamp},S,D,M,Maize,Red,FAQ,20,40,30\n'
                f'{stamp},S,D,M,Maize,Red,,20,40,30\n').encode()
            with tarfile.open(fileobj=result, mode='w') as t:
                member=tarfile.TarInfo('mandi-data-'+rev+'/data/2026/07/2026-07-25.csv')
                member.size=len(text)
                t.addfile(member,io.BytesIO(text))
            result.seek(0)
            return tarfile.open(fileobj=result)
        with archive_for('2026-07-24') as a,self.assertRaisesRegex(ValueError,'arrival date'):
            recent.csv_states(a,rev)
        with archive_for('2026-07-25') as a:
            states=recent.csv_states(a,rev)
        source=dict(recent.CSV_SOURCE,snapshotUrl='https://example.org/source')
        stats=recent.merge(self.dest,date(2026,11,26),rev,states,supplement=source)
        self.assertEqual(stats['matches'],1)
        self.assertEqual(stats['incompleteIdentity'],1)
        meta=json.loads((self.dest/'catalog.json').read_bytes())['series'][0]
        self.assertEqual(meta['supplementalSources'],[source])
        self.assertEqual(meta['shards'][-1]['supplementSnapshots'],[rev])
        self.assertNotIn('recentSource',meta)

    def test_failed_integrity_check_leaves_catalog_untouched(self):
        before=(self.dest/'catalog.json').read_bytes()
        (self.dest/'mandi-maize.json').write_text('[]')
        with self.assertRaisesRegex(ValueError,'Damaged'):
            recent.merge(self.dest,date(2026,11,26),'a'*40,self.state([self.row()]))
        self.assertEqual(before,(self.dest/'catalog.json').read_bytes())
        self.assertFalse((self.dest/'mandi-maize-2026-11.json').exists())


if __name__=='__main__':
    unittest.main()
