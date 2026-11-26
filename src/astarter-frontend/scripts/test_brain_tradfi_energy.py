import csv
from datetime import date
from io import BytesIO, StringIO
import unittest

import brain_tradfi_energy as energy


class EnergyTests(unittest.TestCase):
    def test_french_daily_median_uses_latest_report_from_each_station(self):
        data=b'''<pdv_liste>
        <pdv id="a" cp="75001"><prix nom="Gazole" maj="2016-01-04T09:05:00" valeur="1200"/>
        <prix nom="Gazole" maj="2016-01-04T17:05:00" valeur="1500"/></pdv>
        <pdv id="b" cp="92000"><prix nom="Gazole" maj="2016-01-04T08:05:00" valeur="1300"/></pdv>
        <pdv id="c" cp="75002"><prix nom="Gazole" maj="2016-01-04T08:05:00" valeur="1300"/>
        <prix nom="Gazole" maj="2016-01-04T08:05:00" valeur="1900"/></pdv>
        <pdv id="d" cp="06300"><prix nom="Gazole" maj="2016-01-04T08:05:00" valeur="1320"/></pdv>
        </pdv_liste>'''
        vals=energy.read_report(BytesIO(data),2016,'2016-01-04')
        self.assertEqual(vals['idf','Gazole'],[['2016-01-04',1.4,2]])
        self.assertEqual(vals['pac','Gazole'],[['2016-01-04',1.32,1]])
        recent=b'<pdv_liste><pdv id="a" cp="75001"><prix nom="GPLc" maj="2025-07-06T18:05:00" valeur="0.927"/></pdv></pdv_liste>'
        self.assertEqual(energy.read_report(BytesIO(recent),2025,'2025-07-06')['idf','GPLc'],[['2025-07-06',.927,1]])

    def test_gas_uses_actual_gas_day_and_excludes_future_schedules(self):
        rows=b'gas_date,hub_identifier,hub_name,ex_ante_market_price\r\n26 Nov 2026,BRI,Brisbane,11.85\r\n25 Nov 2026,BRI,Brisbane,11.44\r\n'
        hist={h:{} for h in energy.HUBS}
        energy.merge_gas_report(hist,rows,date(2026,11,25))
        self.assertEqual(hist,{'BRI':{'2026-11-25':11.44},'ADL':{},'SYD':{}})
        with self.assertRaisesRegex(ValueError,'hub mismatch'):
            energy.merge_gas_report(hist,rows.replace(b',Brisbane,',b',Sydney,'),date(2026,11,26))

    def test_tpex_gold_does_not_convert_price_or_create_bars_for_empty_sessions(self):
        def src(day,quantity,label,cnt=1):
            out=StringIO();writer=csv.writer(out)
            writer.writerow(['TITLE','daily'])
            writer.writerow(['DATADATE',f'日期:{day.year-1911}年{day.month:02}月{day.day:02}日'])
            writer.writerow(['HEADER','黃金現貨代號','名稱','最高買','最低賣','日均價','前日均價','漲跌','漲跌幅','最高','最低','最後',label,'成交金額','筆數'])
            writer.writerow(['BODY','AU9901','臺銀金','','',100,'','','',110,90,98,quantity,'22,000',cnt])
            return out.getvalue().encode('cp950')
        earlier=date(2017,7,6); now=date(2025,10,1)
        self.assertEqual(energy.read_gold(src(earlier,22,'成交量'),earlier)['AU9901'][1:],
                         [98,110,90,100,220,22000,1,22])
        self.assertEqual(energy.read_gold(src(now,22,'成交量(台錢)'),now)['AU9901'][5],22)
        self.assertEqual(energy.read_gold(src(now,0,'成交量(台錢)',0),now),{})
        with self.assertRaisesRegex(ValueError,'unit'):
            energy.read_gold(src(now,22,'成交量(台兩)'),now)
        with self.assertRaisesRegex(ValueError,'Wrong exchange date'):
            energy.read_gold(src(earlier,22,'成交量'),now)


if __name__=='__main__':unittest.main()
