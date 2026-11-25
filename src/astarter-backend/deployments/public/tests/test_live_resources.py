"""The explicit local live runner must resolve its original packaged resources."""

import subprocess
import sys
import unittest

from stark_trading_os.control.postgres.public_access import public_sql
from stark_trading_os.control.postgres.synthetic_migration import sql_statements


class LiveResourceTests(unittest.TestCase):
    def test_owner_install_sql_is_packaged_and_parseable(self):
        statements = sql_statements(public_sql())
        for table in ("snapshots", "budgets", "attempts"):
            self.assertTrue(
                any(f"CREATE TABLE public_data.{table}" in statement for statement in statements),
                table,
            )

    def test_resolver_import_and_construction_do_not_start_io(self):
        code = """
import asyncio, socket, subprocess
def fail(*args, **kwargs):
    raise AssertionError('UNEXPECTED_IO')
socket.getaddrinfo = socket.create_connection = socket.socket.connect = fail
subprocess.Popen = asyncio.create_subprocess_exec = asyncio.create_task = fail
from stark_trading_os.integrations.public_data.resolver import PublicDigResolver
resolver = PublicDigResolver()
assert resolver.close_result is None
print('ZERO_IO')
"""
        result = subprocess.run(
            [sys.executable, "-B", "-c", code],
            capture_output=True,
            text=True,
            timeout=30,
            env={},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ZERO_IO")
