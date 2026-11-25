import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from stark_trading_os.control.public_data_live import create_live_public_app

class LiveDefaultTests(unittest.TestCase):
    def test_export_is_disabled_without_config_and_never_opens_pools(self):
        with patch('stark_trading_os.control.public_data_live._LivePool') as pool:
            with TestClient(create_live_public_app()) as client:
                response = client.get('/v1/data/markets')
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json(), {'code': 'PUBLIC_LIVE_DISABLED'})
                self.assertEqual(response.headers['cache-control'], 'no-store')
            pool.assert_not_called()
