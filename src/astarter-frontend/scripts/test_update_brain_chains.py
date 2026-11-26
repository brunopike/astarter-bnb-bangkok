import contextlib
from datetime import date
from hashlib import sha256
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('chain_publish',Path(__file__).with_name('update-brain-chains.py'))
pub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pub)


class ChainPublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.root = base/'release'
        self.prepared = base/'prepared'
        self.until = date(2020,1,1)

    def tearDown(self):
        self.tmp.cleanup()

    def export(self, asset, height=100):
        folder = self.prepared/pub.DIRECTORY[asset]
        folder.mkdir(exist_ok=True, parents=True)
        stamp = pub.evm.day_start(self.until)
        raw = pub.evm.archive.packed([[height,stamp,3]])
        name = f'{asset.lower()}-{self.until}.json.gz'
        (folder/name).write_bytes(raw)
        sh = {'start':str(self.until),'end':str(self.until),'count':1,'file':name,
              'firstHeight':height,'lastHeight':height,'encoding':pub.evm.archive.ENCODING,
              'sha256':sha256(raw).hexdigest(),'sources':[{'url':'https://example.org/record'}]}
        ds = pub.evm.combine(asset,None,[sh])
        path = folder/(asset+'.dataset.json')
        path.write_text(json.dumps(ds))
        return path, ds

    def run_prepared(self, assets):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return pub.publish(self.root,self.prepared,self.until,assets)

    def test_partial_success_and_idempotence(self):
        self.export('BTC')
        self.assertEqual(self.run_prepared(['BTC','BNB']),1)
        manifest = self.root/'manifest.json'
        first = manifest.read_bytes()
        ts = manifest.stat().st_mtime_ns
        self.assertEqual(json.loads(first)['count'],1)
        self.assertEqual(self.run_prepared(['BTC']),0)
        self.assertEqual((manifest.read_bytes(),manifest.stat().st_mtime_ns),(first,ts))
        summary = pub.read_json(self.root/'summary.json')
        self.assertEqual(summary['count'],1)
        self.assertNotIn('shards',summary['datasets'][0])

    def test_prepared_cannot_replace_previously_published_shard(self):
        self.export('ETH')
        self.assertEqual(self.run_prepared(['ETH']),0)
        manifest = (self.root/'manifest.json').read_bytes()
        self.export('ETH',101)
        self.assertEqual(self.run_prepared(['ETH']),1)
        self.assertEqual((self.root/'manifest.json').read_bytes(),manifest)

    def test_rejects_tampered_gzip_and_escaping_filename(self):
        path, ds = self.export('BNB')
        sh = ds['shards'][0]
        original = sh['file']
        sh['file'] = '../outside'
        path.write_text(json.dumps(ds))
        self.assertEqual(self.run_prepared(['BNB']),1)
        self.assertFalse((self.root/'manifest.json').exists())
        sh['file'] = original
        path.write_text(json.dumps(ds))
        (path.parent/original).write_bytes(b'invalid')
        self.assertEqual(self.run_prepared(['BNB']),1)
        self.assertFalse((self.root/original).exists())

    def test_rejects_wrong_record_date_despite_correct_digest(self):
        path, ds = self.export('BNB')
        sh = ds['shards'][0]
        raw = pub.evm.archive.packed([[100,pub.evm.day_start(self.until)-1,3]])
        (path.parent/sh['file']).write_bytes(raw)
        sh['sha256'] = sha256(raw).hexdigest()
        path.write_text(json.dumps(ds))
        self.assertEqual(self.run_prepared(['BNB']),1)
        self.assertEqual(list(self.root.iterdir()),[])


if __name__=='__main__':
    unittest.main()
