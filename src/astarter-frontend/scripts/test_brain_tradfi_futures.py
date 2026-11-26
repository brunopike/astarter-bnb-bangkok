import unittest
from datetime import date, datetime, timezone
from unittest.mock import patch

import brain_tradfi_futures as f

HEADER='date,contract,contract month(Week),open,high,low,last,Change,%,Volume,settlement_price,open_interest,best_bid,best_ask,historical_high,historical_low,trading_halt,Trading Session'
DAY=date(2026,11,25)


def row(month,op,high,low,cl,volume,session,settle=5000):
    return ','.join(map(str,('2026/11/25','BRF',month,op,high,low,cl,'-','-',volume,settle,2,0,0,high,low,'',session)))


def bars(*records):
    payload=('\r\n'.join((HEADER,*records))+'\r\n\x1a').encode()
    return f.read_report(payload,DAY,DAY)


class FuturesTest(unittest.TestCase):
    def test_completion_follows_taipei_midnight(self):
        before = datetime(2026, 11, 26, 15, 59, tzinfo=timezone.utc)
        after = datetime(2026, 11, 26, 16, 0, tzinfo=timezone.utc)
        self.assertEqual(f.latest_completed_day(before), date(2026, 11, 25))
        self.assertEqual(f.latest_completed_day(after), date(2026, 11, 26))


    def test_overnight_precedes_regular_and_nearest_actual_month_wins(self):
        selected=bars(row('202612',91,96,90,95,8,'Regular'),
                      row('202611','-','-','-','-',0,'Regular'),
                      row('202612',98,103,94,97,3,'After Hours'),
                      row('202701',99,101,95,97,500,'Regular'),
                      row('202611W4',99,99,98,98,40,'Regular'),
                      row('202611/202612',1,1,1,1,20,'Regular'))
        self.assertEqual(selected['BRF'][str(DAY)],[str(DAY),95.,98.,103.,90.,11,'202612',3,8])

    def test_after_hours_only_and_regular_only(self):
        item=bars(row('202611',98,103,94,97,3,'After-Hours'))
        self.assertEqual(item['BRF'][str(DAY)][1:],[97,98,103,94,3,'202611',3,0])
        item=bars(row('202611',98,103,94,97,3,'Regular'))
        self.assertEqual(item['BRF'][str(DAY)][7:],[0,3])

    def test_partial_invalid_or_duplicate_session_cannot_be_published(self):
        for rec in (row('202611',99,'-','-',99,1,'Regular'),row('202611',99,90,89,95,3,'Regular')):
            self.assertEqual(bars(rec,row('202612',99,100,90,95,3,'Regular')),{})
        valid=row('202611',98,103,94,97,3,'Regular')
        with self.assertRaisesRegex(ValueError,'Duplicate'):bars(valid,valid)
        with self.assertRaisesRegex(ValueError,'Unknown'):bars(row('202611',98,103,94,97,3,'Other'))

    def test_daily_query_requests_exchange_all_codes(self):
        with patch.object(f,'download',return_value=(HEADER+'\r\n').encode()) as request:
            f.period(DAY,DAY,None)
        args=request.call_args.args[0]
        self.assertEqual((args['commodity_id'],args['queryStartDate'],args['down_type']),('all','2026/11/25','1'))


if __name__=='__main__':unittest.main()
