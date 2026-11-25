"""PRIVATE capabilities reuse the existing pool without implicit target discovery."""

from dataclasses import replace
from os import environ
from unittest.mock import patch

import pytest
from psycopg import Connection
from psycopg.conninfo import make_conninfo

from stark_trading_os.control.postgres.access import RepositoryAccessContract
from stark_trading_os.control.postgres.pool import PgRepositoryPool
from stark_trading_os.control.postgres.private_research_migration import PrivateTarget
from stark_trading_os.control.postgres.synthetic_migration import TargetProfile


def target() -> PrivateTarget:
    return PrivateTarget(
        TargetProfile.LOCAL_PG17,
        "/owned_synthetic",
        55439,
        "private_fixture",
        "private_owner",
        "private_runtime",
        "private_issuer",
        "private_cost",
        "private-local",
    )


def dsn() -> str:
    return make_conninfo(
        host="/owned_synthetic", port=55439, dbname="private_fixture", user="private_runtime"
    )


@pytest.mark.parametrize(
    "change",
    [
        {"host": "/other"},
        {"port": 55440},
        {"database": "public_fixture"},
        {"runtime": "wrong_role"},
    ],
)
def test_target_dsn_mismatch_is_rejected_before_pool_construction(
    change: dict[str, object],
) -> None:
    with patch("stark_trading_os.control.postgres.pool.ConnectionPool") as native:
        with pytest.raises(ValueError, match="PRIVATE_POOL_CONFIGURATION"):
            PgRepositoryPool(
                dsn(),
                access_contract=RepositoryAccessContract.PRIVATE_RESEARCH_V1,
                private_target=replace(target(), **change),
                private_role="runtime",
            )
        native.assert_not_called()


def test_private_pool_requires_both_role_and_explicit_target() -> None:
    with patch("stark_trading_os.control.postgres.pool.ConnectionPool") as native:
        for kwargs in ({}, {"private_target": target()}, {"private_role": "runtime"}):
            with pytest.raises(ValueError, match="PRIVATE_POOL_CONFIGURATION"):
                PgRepositoryPool(
                    dsn(), access_contract=RepositoryAccessContract.PRIVATE_RESEARCH_V1, **kwargs
                )
        native.assert_not_called()


def test_default_contract_cannot_silently_accept_private_target() -> None:
    with patch("stark_trading_os.control.postgres.pool.ConnectionPool") as native:
        with pytest.raises(ValueError, match="PRIVATE_POOL_CONFIGURATION"):
            PgRepositoryPool(dsn(), private_target=target(), private_role="runtime")
        native.assert_not_called()


def test_exact_target_constructs_cold_pool_without_opening() -> None:
    with patch("stark_trading_os.control.postgres.pool.ConnectionPool") as native:
        pool = PgRepositoryPool(
            dsn(),
            access_contract=RepositoryAccessContract.PRIVATE_RESEARCH_V1,
            private_target=target(),
            private_role="runtime",
        )
        native.assert_called_once()
        assert native.call_args.kwargs["open"] is False
        native.return_value.open.assert_not_called()
        pool.close()


def test_local_dsn_cannot_supply_tcp_hostaddr_before_open() -> None:
    with patch("stark_trading_os.control.postgres.pool.ConnectionPool") as native:
        with pytest.raises(ValueError, match="PRIVATE_POOL_CONFIGURATION"):
            PgRepositoryPool(
                make_conninfo(dsn(), hostaddr="127.0.0.1"),
                access_contract=RepositoryAccessContract.PRIVATE_RESEARCH_V1,
                private_target=target(),
                private_role="runtime",
            )
        native.assert_not_called()


@pytest.mark.parametrize("key", ["PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"])
def test_libpq_environment_overrides_are_rejected_before_pool_creation(key: str) -> None:
    with (
        patch.dict(environ, {key: "synthetic-override"}),
        patch("stark_trading_os.control.postgres.pool.ConnectionPool") as native,
    ):
        with pytest.raises(ValueError, match="PRIVATE_POOL_CONFIGURATION"):
            PgRepositoryPool(
                dsn(),
                access_contract=RepositoryAccessContract.PRIVATE_RESEARCH_V1,
                private_target=target(),
                private_role="runtime",
            )
        native.assert_not_called()


@pytest.mark.parametrize("key", ["PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"])
def test_later_worker_connection_rechecks_environment_before_libpq_io(key: str) -> None:
    with patch("stark_trading_os.control.postgres.pool.ConnectionPool") as native:
        pool = PgRepositoryPool(
            dsn(),
            access_contract=RepositoryAccessContract.PRIVATE_RESEARCH_V1,
            private_target=target(),
            private_role="runtime",
        )
        connection_class = native.call_args.kwargs.get("connection_class", Connection)
        with (
            patch.dict(environ, {key: "synthetic-override"}),
            patch.object(Connection, "connect") as driver,
        ):
            with pytest.raises(ValueError, match="PRIVATE_POOL_CONFIGURATION"):
                connection_class.connect(dsn())
            driver.assert_not_called()
        pool.close()


def test_explicit_service_name_cannot_fill_libpq_transport_defaults() -> None:
    with patch("stark_trading_os.control.postgres.pool.ConnectionPool") as native:
        with pytest.raises(ValueError, match="PRIVATE_POOL_CONFIGURATION"):
            PgRepositoryPool(
                make_conninfo(dsn(), service="synthetic"),
                access_contract=RepositoryAccessContract.PRIVATE_RESEARCH_V1,
                private_target=target(),
                private_role="runtime",
            )
        native.assert_not_called()
