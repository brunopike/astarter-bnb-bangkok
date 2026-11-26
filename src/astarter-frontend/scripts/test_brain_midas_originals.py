import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zipfile import ZipFile

path=Path(__file__).with_name('publish-midas-originals.py')
spec=importlib.util.spec_from_file_location('midas_originals',path)
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)


class TestOriginals(unittest.TestCase):
    def indices(self,folder,quarters):
        catalog=[]
        for i,name in enumerate(m.SERIES):
            doc={'id':name,'quarters':[{**r,'count':1+i} for r in quarters]};raw=json.dumps(doc).encode();(folder/(name+'.json')).write_bytes(raw)
            catalog.append({'id':name,'sha256':hashlib.sha256(raw).hexdigest(),'count':len(quarters)*(1+i)})
        (folder/'catalog.json').write_text(json.dumps({'series':catalog}))

    def test_one_asset_per_quarter_and_divergent_receipt_rejection(self):
        with TemporaryDirectory() as tmp:
            root=Path(tmp);row={'quarter':'2016Q1','url':'https://www.sec.gov/files/q.zip','size':123,'sha256':'a'*64}
            self.indices(root,[row]);items=m.records(root,True)
            self.assertEqual([i.filename for i in items],['sec-midas-2016q1-'+'a'*16+'.zip'])
            with self.assertRaises(ValueError):m.records(root)
            path=root/(m.SERIES[1]+'.json');doc=json.loads(path.read_bytes());doc['quarters'][0]['sha256']='b'*64;path.write_text(json.dumps(doc))
            with self.assertRaises(ValueError):m.records(root,True)

    def test_integrity_and_append_only_existing_asset(self):
        with TemporaryDirectory() as tmp:
            sample=Path(tmp)/'source.zip'
            with ZipFile(sample,'w') as z:z.writestr('jan16.csv','ticker,trades\nA,1\n')
            digest=hashlib.sha256(sample.read_bytes()).hexdigest();item=m.Original('2016Q1','https://www.sec.gov/files/q.zip',sample.stat().st_size,digest)
            m.verify_file(sample,item)
            asset={'state':'uploaded','size':item.size,'digest':'sha256:'+digest};self.assertTrue(m.matches(item,asset))
            with self.assertRaises(ValueError):m.matches(item,{**asset,'digest':'sha256:'+'0'*64})
            with sample.open('ab') as f:f.write(b'!')
            with self.assertRaises(ValueError):m.verify_file(sample,item)

    def test_existing_quarters_avoid_network_and_never_override_latest(self):
        with TemporaryDirectory() as tmp:
            root=Path(tmp);quarters=[f'{year}Q{n}' for year in range(2016,2027) for n in range(1,5) if f'{year}Q{n}'<='2026Q3']
            rows=[{'quarter':q,'url':'https://www.sec.gov/files/'+q+'.zip','size':123,'sha256':'a'*64} for q in quarters];self.indices(root,rows)
            live={i.filename:{'state':'uploaded','size':i.size,'digest':'sha256:'+i.sha256} for i in m.records(root)}
            with patch.object(m,'release',return_value={'databaseId':1,'tagName':m.TAG,'isDraft':False}),patch.object(m,'assets',return_value=live),patch.object(m,'gh') as gh,patch.object(m,'upload') as upload:
                m.publish(root,None,False,False,2);gh.assert_not_called();upload.assert_not_called()


if __name__=='__main__':unittest.main()
