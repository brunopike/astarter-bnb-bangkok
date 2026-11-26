from datetime import date
import unittest

from brain_tradfi_us import COMBINED, DILUTED, SEC, issuer_series, quarterly_rows

NVDA = '0001045810'
ACC = '0001045810-24-000123'
COMPARATIVE = '0001045810-25-000200'


def fact(start='2024-04-01', end='2024-06-30', filed='2024-07-25', accession=ACC, value=1.23, form='10-Q'):
    return dict(start=start, end=end, filed=filed, accn=accession, val=value, form=form)


def payload(diluted, combined=()):
    return {'cik': int(NVDA), 'facts': {'us-gaap': {
        DILUTED: {'units': {'USD/shares': list(diluted)}},
        COMBINED: {'units': {'USD/shares': list(combined)}},
    }}}


class IssuerFactsTest(unittest.TestCase):
    reports = {ACC: ('10-Q', '2024-06-30', '2024-07-25')}

    def test_matches_exact_original_period_filing_and_duration(self):
        cases = [fact(), fact(), fact(start='2024-01-01', value=3.8),
                 fact(end='2023-06-30', start='2023-04-01', value=7),
                 fact(accession=COMPARATIVE, filed='2025-07-25', value=4),
                 fact(form='10-Q/A', value=5), fact(filed='2024-07-26', value=6)]
        rows, combined = quarterly_rows(payload(cases), self.reports)
        self.assertEqual(rows, [['2024-07-25', 1.23, '2024-06-30', ACC]])
        self.assertEqual(combined, [])

    def test_original_combined_tag_records_loss_without_basic_only_substitution(self):
        test = payload([], [fact(value=-2.13)])
        test['facts']['us-gaap']['EarningsPerShareBasic'] = {'units': {'USD/shares': [fact(value=8)]}}
        self.assertEqual(quarterly_rows(test, self.reports),
                         ([['2024-07-25', -2.13, '2024-06-30', ACC]], [ACC]))
        del test['facts']['us-gaap'][COMBINED]
        self.assertEqual(quarterly_rows(test, self.reports), ([], []))

    def test_does_not_infer_fourth_quarter_from_year_to_date(self):
        annual = fact(start='2024-01-01', end='2024-12-31', filed='2025-01-29', form='10-K', value=4.0)
        report = {ACC: ('10-K', '2024-12-31', '2025-01-29')}
        self.assertEqual(quarterly_rows(payload([annual]), report), ([], []))
        fourth = {**annual, 'start': '2024-10-01', 'val': 0}
        self.assertEqual(quarterly_rows(payload([annual, fourth]), report)[0][0][1], 0)

    def test_conflicting_values_or_nonfinite_numbers_rejected(self):
        for invalid in [payload([fact(), fact(value=4)]), payload([fact()], [fact(value=9)]),
                        payload([fact(value=float('nan'))]), payload([fact(value=True)])]:
            with self.assertRaises(ValueError):
                quarterly_rows(invalid, self.reports)

    def test_reads_older_submissions_and_keeps_other_company_failure_separate(self):
        empty_columns = {k: [] for k in ('accessionNumber', 'form', 'filingDate', 'reportDate')}
        name = 'CIK'+NVDA+'-submissions-001.json'
        submissions = {'cik': NVDA, 'filings': {'recent': empty_columns, 'files': [
            {'filingFrom': '2000-01-01', 'filingTo': '2024-08-01', 'name': name}]}}
        table = dict(accessionNumber=[ACC, COMPARATIVE], form=['10-Q', '10-Q'],
                     filingDate=['2024-07-25', '2025-07-25'], reportDate=['2024-06-30', '2025-06-30'])
        files = {
            SEC+'submissions/CIK'+NVDA+'.json': submissions,
            SEC+'submissions/'+name: table,
            SEC+'api/xbrl/companyfacts/CIK'+NVDA+'.json': payload(
                [fact(), fact(start='2025-04-01', end='2025-06-30', filed='2025-07-25', accession=COMPARATIVE, value=8)]),
        }

        def fetch(url):
            if url not in files:
                raise OSError('unavailable')
            return files[url]

        series, errors = issuer_series(date(2024, 7, 25), fetch)
        rows, meta = series['nvda-eps']
        self.assertEqual(rows, [['2024-07-25', 1.23, '2024-06-30', ACC]])
        self.assertEqual(meta['unit'], 'USD/share')
        self.assertEqual(meta['cik'], NVDA)
        self.assertEqual(meta['statistic'], 'dilutedEps')
        self.assertEqual(errors, {'tsla-eps': 'unavailable'})
        self.assertEqual(issuer_series(date(2024, 7, 24), fetch)[0], {})
        files[SEC+'api/xbrl/companyfacts/CIK'+NVDA+'.json'] = payload([fact()])
        partial, failed = issuer_series(date(2025, 7, 25), fetch)
        self.assertNotIn('nvda-eps', partial)
        self.assertIn('2025-06-30', failed['nvda-eps'])


if __name__ == '__main__':
    unittest.main()
