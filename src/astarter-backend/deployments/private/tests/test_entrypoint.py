"""Exported ASGI entrypoint stays inert without PRIVATE configuration."""

import asyncio
import os
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx


class ColdEntrypointTests(unittest.TestCase):
    def test_default_entrypoint_has_no_database_or_network_io(self):
        root = Path(__file__).resolve().parents[1]
        keys = (
            "ASTARTER_PRIVATE_TARGET_JSON", "ASTARTER_PRIVATE_LEASE_JSON",
            "ASTARTER_PRIVATE_RUNTIME_DATABASE_URL", "ASTARTER_PRIVATE_ISSUER_DATABASE_URL",
            "PRIVATE_RUNTIME_TOKEN", "PRIVATE_ISSUER_TOKEN",
        )
        with (
            patch.dict(os.environ, dict.fromkeys(keys, "")),
            patch("socket.getaddrinfo", side_effect=AssertionError("UNEXPECTED_DNS")),
            patch("socket.create_connection", side_effect=AssertionError("UNEXPECTED_TCP")),
            patch("psycopg.connect", side_effect=AssertionError("UNEXPECTED_DATABASE")),
        ):
            exported = runpy.run_path(str(root / "app.py"))
            app = exported["app"]

            async def request():
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://fixture.invalid"
                ) as client:
                    response = await client.post("/internal/private/v1/lease", json={})
                    self.assertEqual(response.status_code, 503)
                    self.assertEqual(response.json()["code"], "PRIVATE_UNCONFIGURED")
                    self.assertEqual(response.headers["cache-control"], "no-store")

            asyncio.run(request())
        import stark_trading_os.control.private_research_service as service

        self.assertTrue(Path(service.__file__).is_relative_to(root))

    def test_partial_configuration_fails_with_fixed_code(self):
        from stark_trading_os.control.private_research_service import PrivateServiceConfig

        with self.assertRaisesRegex(ValueError, "^PRIVATE_SERVICE_CONFIGURATION$"):
            PrivateServiceConfig.from_env({"PRIVATE_RUNTIME_TOKEN": "fixture"})


if __name__ == "__main__":
    unittest.main()
