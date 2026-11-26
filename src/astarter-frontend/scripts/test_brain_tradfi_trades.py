import unittest
from datetime import date
import brain_tradfi_trades as t


class Form4Samples(unittest.TestCase):
    def row(self, **overrides):
        values=dict(title='Common Stock',code='S',direction='D',swap='false',price='123.4567',
                    shares='40',date='12-JUN-2017',refs=[],priceRefs=[],key='1')
        return {**values,**overrides}

    def one(self, notes=None, **overrides):
        return t.candidate('AAPL','2017-06-13','0000320193-17-000001',self.row(**overrides),notes or {},'https://www.sec.gov/')

    def test_transaction_fields_and_date(self):
        x=self.one()
        self.assertEqual(x[:5],['2017-06-13',123.4567,'2017-06-12','S',40])
        self.assertEqual((x[5],x[8],x[11]),('reportedPrice','notDisclosed','123.4567'))
        for args in ({'price':'0'},{'price':'NaN'},{'code':'F'},{'swap':'true'},
                     {'direction':'A'},{'title':'Restricted Stock Units'},{'shares':'-1'}):
            self.assertIsNone(self.one(**args))
        with self.assertRaises(ValueError): self.one(date='2017-06-14')

    def test_linked_footnotes_classify_price_and_venue(self):
        notes={'F1':'Shares were sold in the open market.',
               'F2':'The reported price is a weighted average of sales.'}
        x=self.one(notes,refs=['F2','F1'],priceRefs=['F2'])
        self.assertEqual((x[5],x[8],x[9]),('reportedWeightedAverage','explicitOpenMarket',['F1','F2']))
        self.assertEqual(x[12][0][0],'F2')
        self.assertEqual(self.one(notes,refs=['F1'],priceRefs=[])[5],'reportedPrice')
        self.assertIsNone(self.one({'F1':'Privately negotiated sale to another person.'},refs=['F1']))
        with self.assertRaises(ValueError):self.one({},refs=['F9'])

    def test_month_uses_disclosure_then_deterministic_tranche(self):
        winners={'AAPL':{}}
        for sh in ('35','100','25'):
            t.keep(winners,'AAPL',self.one(shares=sh))
        self.assertEqual(winners['AAPL']['2017-06'][4],100)
        x=self.one(shares='5');x[0]='2017-06-19';t.keep(winners,'AAPL',x)
        self.assertEqual(winners['AAPL']['2017-06'][4],5)

    def test_missing_quarter_is_not_silently_skipped(self):
        base='https://www.sec.gov/files/structureddata/'
        html=''.join(f'<a href="{base}2016q{q}_form345.zip">' for q in (1,3))
        with self.assertRaisesRegex(ValueError,'Missing SEC quarter'):
            t.quarter_links(html,date(2016,12,31))

    def trade_xml(self):
        return '''<ownershipDocument><documentType>4</documentType><issuer>
        <issuerCik>320193</issuerCik><issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer>
        <nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle>
        <transactionDate><value>2017-06-12</value></transactionDate><transactionCoding><transactionCode>S</transactionCode>
        </transactionCoding><transactionAmounts><transactionPricePerShare><value>123.4567</value><footnoteId id="F1"/>
        </transactionPricePerShare><transactionShares><value>40</value></transactionShares>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
        </nonDerivativeTransaction></nonDerivativeTable><footnotes><footnote id="F1">Weighted average sales price.</footnote>
        </footnotes></ownershipDocument>'''

    def original(self, accession, accepted, price):
        xml = self.trade_xml().replace('123.4567', price)
        return (f'<SEC-HEADER>ACCESSION NUMBER: {accession}\nFILED AS OF DATE: 20170613\n'
                f'<ACCEPTANCE-DATETIME>20170613{accepted}\n</SEC-HEADER>\n'
                '<DOCUMENT>\n<TYPE>4\n<FILENAME>ownership.xml\n' + xml + '\n</DOCUMENT>').encode()

    def test_original_price_precision_and_acceptance_break_same_day_tie(self):
        later = self.one(price='190.40')
        earlier = self.one(price='200.10')
        earlier[6] = '0000320193-17-000099'
        raw = {
            later[6]: self.original(later[6], '170002', '190.395'),
            earlier[6]: self.original(earlier[6], '162000', '200.099'),
        }
        def load(url):
            return raw[url.rsplit('/', 1)[-1][:-4]]
        hints = {row[6]: row for row in (later, earlier)}
        picked = t.resolve('AAPL', hints, {}, load, None)
        self.assertEqual(picked[1], 190.395)
        self.assertEqual(picked[11], '190.395')
        self.assertEqual(picked[13], '2017-06-13T21:00:02Z')
        self.assertEqual(picked[6], later[6])
        self.assertTrue(picked[7].endswith('/ownership.xml'))
        with self.assertRaisesRegex(ValueError, 'accession or disclosure date'):
            t.original_sample('AAPL', earlier, raw[later[6]])

    def test_live_xml_matches_issuer_and_rejects_inconsistent_security(self):
        xml = self.trade_xml()
        out={'AAPL':{}}
        t.xml_rows(xml,'AAPL','2017-06-13','0000320193-17-000001','one.xml',out)
        self.assertEqual(out['AAPL']['2017-06'][5],'reportedWeightedAverage')
        with self.assertRaisesRegex(ValueError,'issuer'):
            t.xml_rows(xml,'NVDA','2017-06-13','0000320193-17-000001','one.xml',out)


if __name__=='__main__':unittest.main()
