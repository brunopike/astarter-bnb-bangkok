import hashlib
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from stark_trading_os.integrations.transport import HttpRequest, HttpResponse

NOW = 1700000000100
ORIGIN = "https://astarter.imstark.site"


class Tickers:
    purpose = "OFFLINE_FIXTURE"

    def __init__(self):
        self.calls = 0
        self.fail = False
        self.future = False
        self.percentages = {"BTCUSDT": "2.500", "ETHUSDT": "-1.250", "SOLUSDT": "0.000"}

    async def send(self, request):
        self.calls += 1
        if self.fail:
            return HttpResponse(429, b"{}", (("retry-after", "30"),))
        symbol = request.url.split("symbol=")[1].split("&")[0]
        data = dict(
            symbol=symbol,
            lastPrice="65000.12000000",
            volume="12.34000000",
            quoteVolume="802101.48080000",
            openTime=1699913600000,
            closeTime=NOW + 100 if self.future else 1700000000000,
        )
        if symbol in self.percentages:
            data["priceChangePercent"] = self.percentages[symbol]
        return HttpResponse(200, json.dumps(data).encode(), (("content-type", "application/json"),))


class CloudTests(unittest.TestCase):
    def client(self, transport=None, clock=None):
        from cloud import create_app

        return TestClient(
            create_app(market_transport=transport or Tickers(), clock_ms=clock or (lambda: NOW))
        )

    def test_health_is_zero_io_and_truthful(self):
        transport = Tickers()
        with self.client(transport) as client:
            result = client.get("/healthz", headers={"Origin": ORIGIN})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.headers["access-control-allow-origin"], ORIGIN)
            self.assertEqual(result.headers["cache-control"], "no-store")
            body = result.json()
            self.assertFalse(body["capabilities"]["trading"])
            self.assertFalse(body["capabilities"]["wallet_auth"])
            self.assertFalse(body["capabilities"]["commerce"])
            self.assertFalse(body["capabilities"]["paid_sources"])
            self.assertEqual(transport.calls, 0)

    def test_real_contract_three_assets_shared_reads_keep_first_times(self):
        transport = Tickers()
        with self.client(transport) as client:
            first = client.get("/v1/data/markets", headers={"Origin": ORIGIN}).json()
            second = client.get(
                "/v1/data/markets?selection_version=7", headers={"Origin": ORIGIN}
            ).json()
            self.assertEqual(first["schema_version"], "AstarterPublicData.v1")
            self.assertEqual(first["quality"], "fresh")
            self.assertEqual(len(first["items"]), 3)
            self.assertEqual(
                [row["data"]["price_change_pct"] for row in first["items"]],
                ["2.500", "-1.250", "0.000"],
            )
            self.assertEqual(first["items"], second["items"])
            self.assertEqual(first["as_of_ms"], second["as_of_ms"])
            self.assertEqual(second["selection_version"], 7)
            self.assertEqual(transport.calls, 3)
            self.assertFalse(first["real_trading_connected"])
            self.assertEqual(first["execution_binding"], "NONE")

    def test_origin_preflight_and_bad_query_never_fetch(self):
        transport = Tickers()
        with self.client(transport) as client:
            allowed = client.get("/healthz", headers={"Origin": "https://ipfund.art"})
            self.assertEqual(allowed.status_code, 200)
            self.assertEqual(allowed.headers["access-control-allow-origin"], "https://ipfund.art")
            self.assertEqual(
                allowed.json()["frontend_origins"],
                ["https://astarter.imstark.site", "https://ipfund.art"],
            )
            for origin in [
                "https://evil.invalid",
                "https://astarter.imstark.site.evil.invalid",
                "https://ipfund.art.evil.invalid",
                "https://www.ipfund.art",
                "null",
            ]:
                out = client.get("/v1/data/markets", headers={"Origin": origin})
                self.assertEqual(out.status_code, 403)
                self.assertNotIn("access-control-allow-origin", out.headers)
            out = client.options(
                "/v1/data/markets",
                headers={"Origin": ORIGIN, "Access-Control-Request-Method": "GET"},
            )
            self.assertEqual(out.status_code, 204)
            out = client.get("/v1/data/markets", headers=[("Origin", ORIGIN), ("Origin", ORIGIN)])
            self.assertEqual(out.status_code, 403)
            out = client.options(
                "/v1/data/markets",
                headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST"},
            )
            self.assertEqual(out.status_code, 405)
            for query in [
                "asset_ids=unknown",
                "url=https://evil.invalid",
                "asset_ids=bitcoin&asset_ids=solana",
            ]:
                self.assertEqual(client.get("/v1/data/markets?" + query).status_code, 400)
            self.assertEqual(
                client.post("/v1/data/markets", headers={"Origin": ORIGIN}).status_code, 405
            )
            self.assertEqual(transport.calls, 0)

    def test_paid_sources_unconfigured_and_chain_not_verified(self):
        transport = Tickers()
        with self.client(transport) as client:
            for path in ["assets", "news"]:
                result = client.get("/v1/data/" + path).json()
                self.assertEqual(result["quality"], "unavailable")
                self.assertEqual(result["items"], [])
                self.assertTrue(all(s["status"] == "UNCONFIGURED" for s in result["sources"]))
            capabilities = client.get("/v1/data/explorer/capabilities?provider_id=etherscan").json()
            self.assertTrue(
                all(
                    row["data"]["verification_state"] == "UNTESTED" for row in capabilities["items"]
                )
            )
            self.assertEqual(transport.calls, 0)

    def test_future_source_is_not_clamped_or_made_fresh(self):
        transport = Tickers()
        transport.future = True
        with self.client(transport) as client:
            result = client.get("/v1/data/markets").json()
            self.assertEqual(result["quality"], "unavailable")
            self.assertEqual(result["items"], [])
            self.assertIsNone(result["as_of_ms"])

    def test_rate_limit_retains_original_last_good_as_stale(self):
        transport = Tickers()
        clock = {"now": NOW}
        with self.client(transport, lambda: clock["now"]) as client:
            before = client.get("/v1/data/markets").json()
            transport.fail = True
            clock["now"] += 31000
            after = client.get("/v1/data/markets").json()
            self.assertEqual(after["quality"], "stale")
            self.assertEqual(after["as_of_ms"], before["as_of_ms"])
            self.assertTrue(all(row["quality"] == "stale" for row in after["items"]))
            self.assertEqual(
                after["items"][0]["event_time_ms"], before["items"][0]["event_time_ms"]
            )
            self.assertEqual(
                after["items"], [row | {"quality": "stale"} for row in before["items"]]
            )

    def test_missing_percentage_remains_unknown_in_legacy_payload(self):
        transport = Tickers()
        transport.percentages = {}
        with self.client(transport) as client:
            body = client.get("/v1/data/markets").json()
            self.assertEqual(body["quality"], "fresh")
            self.assertTrue(all(row["data"]["price_change_pct"] is None for row in body["items"]))

    def test_invalid_percentage_retains_only_its_last_good_row_with_original_clocks(self):
        transport = Tickers()
        clock = {"now": NOW}
        with self.client(transport, lambda: clock["now"]) as client:
            before = client.get("/v1/data/markets").json()
            transport.percentages["BTCUSDT"] = "NaN"
            clock["now"] += 31000
            after = client.get("/v1/data/markets").json()
            self.assertIn("bitcoin", after["coverage"]["gaps"])
            self.assertEqual(after["items"][0], before["items"][0] | {"quality": "stale"})
            self.assertTrue(any(s["status"] == "INVALID_RESPONSE" for s in after["sources"]))
            self.assertEqual(transport.calls, 6)

    def test_sensitive_and_trade_paths_are_not_served(self):
        with self.client() as client:
            for path in [
                "/.env",
                "/source-manifest.json",
                "/.git/config",
                "/api/commerce/state",
                "/api/wallet/session",
                "/v1/orders",
                "/docs",
                "/openapi.json",
            ]:
                self.assertEqual(client.get(path).status_code, 404)

    def test_shared_modules_match_exported_source_exactly(self):
        root = Path(__file__).resolve().parents[1]
        manifest = json.loads((root / "source-manifest.json").read_text())
        for name, expected in manifest["files"].items():
            self.assertEqual(hashlib.sha256((root / name).read_bytes()).hexdigest(), expected)

    def test_cold_import_never_connects_or_creates_a_database(self):
        code = """
import socket, sqlite3, threading, asyncio
def fail(*a, **k): raise AssertionError('UNEXPECTED_IO')
socket.getaddrinfo = socket.create_connection = socket.socket.connect = fail
sqlite3.connect = threading.Thread.start = asyncio.create_task = fail
from app import app
print('ZERO_IO')
"""
        result = subprocess.run(
            [sys.executable, "-B", "-c", code], capture_output=True, text=True, timeout=30,
            env={},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ZERO_IO")


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_timeout_is_sanitized_and_response_limits_fail_closed(self):
        from cloud_transport import PublicMarketTransport
        from stark_trading_os.integrations.transport import MAX_RESPONSE_BYTES, TransportRejected

        real_client = httpx.AsyncClient
        request = HttpRequest(
            "GET", "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT&type=FULL"
        )
        for case in ["timeout", "size", "html"]:

            async def respond(request):
                if case == "timeout":
                    raise httpx.ReadTimeout("DO_NOT_EXPOSE_PROVIDER_DETAIL")
                return httpx.Response(
                    200,
                    content=b"x" * (MAX_RESPONSE_BYTES + 1) if case == "size" else b"<html>",
                    headers={"content-type": "application/json" if case == "size" else "text/html"},
                )

            def factory(**kwargs):
                return real_client(transport=httpx.MockTransport(respond), **kwargs)

            with patch("cloud_transport.httpx.AsyncClient", side_effect=factory):
                with self.assertRaises(TransportRejected) as captured:
                    await PublicMarketTransport().send(request)
                self.assertNotIn("PROVIDER_DETAIL", str(captured.exception))

    async def test_only_fixed_public_gets_are_allowed(self):
        from cloud_transport import PublicMarketTransport

        transport = PublicMarketTransport()
        for request in [
            HttpRequest("POST", "https://api.binance.com/api/v3/order"),
            HttpRequest("GET", "http://127.0.0.1/private"),
            HttpRequest(
                "GET",
                "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT&type=FULL",
                (("Authorization", "not-a-real-secret"),),
            ),
        ]:
            with self.assertRaises(ValueError):
                await transport.send(request)

    async def test_transport_uses_public_alias_and_bounded_response(self):
        from cloud_transport import PublicMarketTransport

        real_client = httpx.AsyncClient
        seen = []

        async def respond(request):
            seen.append(str(request.url))
            return httpx.Response(200, json={"public": True})

        def factory(**kwargs):
            self.assertFalse(kwargs["trust_env"])
            self.assertFalse(kwargs["follow_redirects"])
            return real_client(transport=httpx.MockTransport(respond), **kwargs)

        request = HttpRequest(
            "GET", "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT&type=FULL"
        )
        with patch("cloud_transport.httpx.AsyncClient", side_effect=factory):
            result = await PublicMarketTransport().send(request)
        self.assertEqual(result.status, 200)
        self.assertTrue(seen[0].startswith("https://data-api.binance.vision/"))


if __name__ == "__main__":
    unittest.main()
