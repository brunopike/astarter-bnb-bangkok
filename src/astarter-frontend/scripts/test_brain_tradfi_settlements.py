import io
import unittest
from zipfile import ZipFile

from brain_tradfi_settlements import HEADER, read_release


def report(total=138):
    content = '\n'.join([
        HEADER,
        '20261030|037833100|AAPL|8|APPLE|348.91',
        '20261030|000000000|AAPL|90|DIFFERENT SECURITY|1.21',
        '20261030|67066G104|NVDA|40|NVIDIA|.',
        'Trailer record count 3',
        f'Trailer total quantity of shares {total}',
    ])
    stream = io.BytesIO()
    with ZipFile(stream, 'w') as archive:
        archive.writestr('cnsfails202610b.txt', content)
    return stream.getvalue()


class SettlementTests(unittest.TestCase):
    def test_identity_missing_prices_and_total(self):
        self.assertEqual(read_release(report(), '202610b'), {
            ('AAPL', '2026-10-30'): ['2026-10-30', 348.91, 8, '202610b'],
        })
        with self.assertRaisesRegex(ValueError, 'totals'):
            read_release(report(total=137), '202610b')
        with self.assertRaisesRegex(ValueError, 'outside'):
            read_release(report(), '202609b')
