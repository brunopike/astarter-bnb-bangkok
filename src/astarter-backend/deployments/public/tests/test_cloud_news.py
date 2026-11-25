"""R1 gate fallback: the standard entry keeps paid sources unavailable and never collects on GET.

Synthetic values only. A vendor name in the process environment is not configuration, repeated
reader refreshes reach no upstream, and an unavailable feed is never shaped like a successful
empty feed. These checks use the original entry and mocks; they are not cloud or vendor evidence.

Every outbound path of the provider that the entry builds is watched. Market reads go to the
counting fixture below. News and asset reads would pass through send_once in the provider module,
which is replaced by a recorder that fails the test. The provider's construction is checked for
credentials and for news or asset transports. Tests 2 and 3 remove both vendor names from the
environment, so they cannot reach a vendor even where the build environment holds real values.
"""

import os
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from fastapi.testclient import TestClient

from stark_trading_os.integrations.transport import HttpResponse

NOW = 1700000000100
ORIGIN = "https://astarter.imstark.site"
VENDOR_NAMES = ("BLOCKBEATS_API_KEY", "COINGECKO_API_KEY")
SYNTHETIC = "synthetic-only"
OUTBOUND = "stark_trading_os.integrations.public_data.providers.send_once"


class Market:
    purpose = "OFFLINE_FIXTURE"

    def __init__(self):
        self.calls = 0

    async def send(self, request):
        self.calls += 1
        return HttpResponse(429, b"{}", (("retry-after", "30"),))


class NewsGateTests(unittest.TestCase):
    def setUp(self):
        import cloud

        self.outbound = []
        self.providers = []
        build = cloud.PublicDataProvider

        async def recorder(transport, request, **kwargs):
            # Keep only the method and host: the headers would carry a key.
            self.outbound.append((request.method, urlsplit(request.url).hostname))
            raise AssertionError("a news or asset read reached the outbound boundary")

        def watched(*args, **kwargs):
            self.providers.append(sorted(kwargs))
            self.assertEqual(args, ())
            self.assertIsNone(kwargs.get("news_transport"))
            self.assertIsNone(kwargs.get("asset_transport"))
            credentials = kwargs.get("credentials")
            if credentials is not None:
                self.assertIsNone(credentials.blockbeats_api_key)
                self.assertIsNone(credentials.coingecko_api_key)
            return build(*args, **kwargs)

        for patcher in (
            patch(OUTBOUND, recorder),
            patch.object(cloud, "PublicDataProvider", watched),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def without_vendor_names(self):
        patcher = patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in VENDOR_NAMES:
            os.environ.pop(name, None)

    def assert_no_outbound_path(self):
        self.assertTrue(self.providers, "the entry no longer builds the watched provider")
        self.assertEqual(self.outbound, [])

    def client(self, transport):
        from cloud import create_app

        return TestClient(create_app(market_transport=transport, clock_ms=lambda: NOW))

    def test_vendor_names_in_the_environment_do_not_enable_paid_sources(self):
        transport = Market()
        with patch.dict(os.environ, {name: SYNTHETIC for name in VENDOR_NAMES}):
            with self.client(transport) as client:
                for path in ["news", "assets"]:
                    result = client.get("/v1/data/" + path, headers={"Origin": ORIGIN})
                    self.assertEqual(result.status_code, 200)
                    body = result.json()
                    self.assertEqual(body["quality"], "unavailable")
                    self.assertEqual(body["items"], [])
                    self.assertIsNone(body["as_of_ms"])
                    self.assertTrue(body["sources"])
                    self.assertTrue(all(s["status"] == "UNCONFIGURED" for s in body["sources"]))
                    self.assertNotIn(SYNTHETIC, result.text)
                # Labelled: both health flags are fixed literals in cloud.py (L82 and L88), so
                # they cannot notice a wired key. The provider and outbound checks are the proof.
                health = client.get("/healthz").json()
                self.assertFalse(health["capabilities"]["paid_sources"])
                self.assertFalse(health["upstream_probe_performed"])
        self.assertEqual(transport.calls, 0)
        self.assert_no_outbound_path()

    def test_repeated_news_refreshes_never_reach_an_upstream(self):
        self.without_vendor_names()
        transport = Market()
        request_ids = set()
        with self.client(transport) as client:
            for version in range(1, 6):
                for limit in (20, 50):
                    result = client.get(
                        f"/v1/data/news?limit={limit}&selection_version={version}",
                        headers={"Origin": ORIGIN},
                    )
                    self.assertEqual(result.status_code, 200)
                    self.assertEqual(result.headers["cache-control"], "no-store")
                    body = result.json()
                    self.assertEqual(body["selection_version"], version)
                    self.assertEqual(body["quality"], "unavailable")
                    self.assertEqual(body["items"], [])
                    self.assertTrue(all(s["status"] == "UNCONFIGURED" for s in body["sources"]))
                    request_ids.add(body["request_id"])
        self.assertEqual(len(request_ids), 10)
        self.assertEqual(transport.calls, 0)
        self.assert_no_outbound_path()

    def test_unavailable_news_is_not_shaped_like_a_successful_empty_feed(self):
        self.without_vendor_names()
        transport = Market()
        with self.client(transport) as client:
            body = client.get("/v1/data/news").json()
        self.assertEqual(body["quality"], "unavailable")
        self.assertIsNone(body["as_of_ms"])
        self.assertEqual(body["coverage"]["returned_subjects"], [])
        self.assertEqual(body["coverage"]["gaps"], ["news"])
        self.assertTrue(body["missing_capabilities"])
        self.assertFalse(any(s["status"] == "OK" for s in body["sources"]))
        self.assertTrue(all(s["last_success_at_ms"] is None for s in body["sources"]))
        self.assertFalse(body["real_trading_connected"])
        self.assertEqual(body["execution_binding"], "NONE")
        self.assertEqual(transport.calls, 0)
        self.assert_no_outbound_path()


if __name__ == "__main__":
    unittest.main()
