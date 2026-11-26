import io
import unittest
import brain_tradfi_equities as w


class WikiTests(unittest.TestCase):
    def test_raw_values_and_invalid_day_are_distinct(self):
        vals=[b'10.1',b'11',b'8',b'9',b'203.0']
        self.assertEqual(w.bar('2018-03-27',vals),['2018-03-27',9,10.1,11,8,203])
        vals[0]=b'12'
        self.assertIsNone(w.bar('2018-03-27',vals))
        vals[0],vals[4]=b'10',b'1.1'
        with self.assertRaisesRegex(ValueError,'volume'):w.bar('2018-03-27',vals)

    def test_immutable_archive_rejects_duplicate_trade_date(self):
        record=b'AAPL,2018-03-27,10,11,9,9,200.0,0,1,10,11,9,9,200\n'
        raw=io.BytesIO(w.HEADER+b'\n'+record+record)
        with self.assertRaisesRegex(ValueError,'duplicate'):list(w.iter_symbols(raw,w.LAST,[]))

if __name__=='__main__':unittest.main()
