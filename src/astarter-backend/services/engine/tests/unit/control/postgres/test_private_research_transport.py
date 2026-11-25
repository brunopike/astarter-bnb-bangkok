"""Offline real Psycopg Connection/ConnectionInfo over synthetic PQ attributes, zero IO."""

from typing import Any, cast

import pytest
from psycopg import Connection
from psycopg.pq import ConnStatus

from stark_trading_os.control.postgres.access import AccessRejected
from stark_trading_os.control.postgres.private_research_migration import check_connection
from tests.unit.control.postgres.test_private_research_pool import target


class PQAttributes:
    host = b"/owned_synthetic"
    port = b"55439"
    db = b"private_fixture"
    user = b"private_runtime"
    _encoding = "utf-8"
    status = ConnStatus.OK

    def __init__(self, address: bytes) -> None:
        self.hostaddr = address

    def finish(self) -> None:
        self.status = ConnStatus.BAD


@pytest.mark.parametrize("address", [b"127.0.0.1", b"203.0.113.1", b"::1"])
def test_local_host_label_cannot_attest_actual_tcp_address(address: bytes) -> None:
    connection: Connection[Any] = Connection(cast(Any, PQAttributes(address)))
    try:
        assert connection.info.host == target().host
        assert connection.info.hostaddr == address.decode()
        with pytest.raises(AccessRejected, match="PRIVATE_CONNECTION_REJECTED"):
            check_connection(connection, target(), target().runtime)
    finally:
        connection.close()


def test_actual_empty_hostaddr_preserves_unix_admission() -> None:
    connection: Connection[Any] = Connection(cast(Any, PQAttributes(b"")))
    try:
        check_connection(connection, target(), target().runtime)
    finally:
        connection.close()
