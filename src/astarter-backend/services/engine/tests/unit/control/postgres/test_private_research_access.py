"""Bounded PRIVATE handshake batching on fresh owned Unix PG17 only."""

import json
import time

import pytest
from fastapi.testclient import TestClient
from psycopg import Connection, pq, sql
from psycopg.conninfo import make_conninfo

from stark_trading_os.control.postgres.access import AccessRejected
from stark_trading_os.control.postgres.pool import PersistenceUnavailable
from stark_trading_os.control.postgres.private_research_access import verify_private_access
from stark_trading_os.control.private_research_service import (
    PrivateServiceConfig,
    create_private_service,
)
from tests.unit.control.postgres.test_private_research_migration import db as db
from tests.unit.control.postgres.test_private_research_migration import native
from tests.unit.control.postgres.test_private_research_migration import pg as pg
from tests.unit.control.postgres.test_private_research_repository import lease, pool_for


@native
@pytest.mark.parametrize("role", ["runtime", "issuer", "cost"])
def test_private_handshake_has_bounded_waits_and_keeps_per_transaction_checks(
    db, monkeypatch, role,
):
    _, _, target = db
    pool = pool_for(target, role)
    try:
        pool.open()
        calls = []
        original = Connection.execute

        def observed(connection, query, *args, **kwargs):
            calls.append(1)
            return original(connection, query, *args, **kwargs)

        with monkeypatch.context() as patch:
            patch.setattr(Connection, "execute", observed)
            for _ in range(2):
                before = len(calls)
                with pool.transaction():
                    pass
                assert len(calls) - before == 12
        print(json.dumps({"role": role, "transactions": 2, "execute_calls": len(calls)}))
    finally:
        pool.close()


@native
@pytest.mark.parametrize("mutation", ["missing", "extra", "sql_error"])
def test_bad_batch_stops_before_business_rolls_back_and_reuses_pool(db, monkeypatch, mutation):
    _, _, target = db
    pool = pool_for(target, "runtime")
    try:
        pool.open()
        with pool._pool.connection() as connection:
            pid = connection.info.backend_pid
        original = Connection.execute

        def changed(connection, query, *args, **kwargs):
            if isinstance(query, str) and query.startswith("SELECT rolname,rolcanlogin"):
                if mutation == "missing":
                    query = query.rsplit(";", 1)[0]
                elif mutation == "extra":
                    query += ";SELECT 1"
                else:
                    query = query.replace(
                        "pg_has_role(current_user,oid,'MEMBER')", "(1/0=1)"
                    )
            return original(connection, query, *args, **kwargs)

        expected = PersistenceUnavailable if mutation == "sql_error" else AccessRejected
        with monkeypatch.context() as patch:
            patch.setattr(Connection, "execute", changed)
            with pytest.raises(expected):
                with pool.transaction():
                    pytest.fail("BAD_HANDSHAKE_REACHED_BUSINESS")
        with pool._pool.connection() as connection:
            assert connection.info.backend_pid == pid
            assert connection.info.transaction_status == pq.TransactionStatus.IDLE
        with pool.transaction():
            pass
    finally:
        pool.close()


@native
def test_wrong_search_path_is_rejected_before_catalog_batch(db, monkeypatch):
    pg, _, target = db
    with pg.connect(user=target.runtime, dbname=target.database) as connection:
        with connection.transaction():
            connection.execute("SET LOCAL search_path=pg_catalog,public")
            queries = []
            original = Connection.execute

            def observed(connection, query, *args, **kwargs):
                queries.append(query)
                return original(connection, query, *args, **kwargs)

            with monkeypatch.context() as patch:
                patch.setattr(Connection, "execute", observed)
                with pytest.raises(AccessRejected, match="PRIVATE_ACCESS_SEARCH_PATH"):
                    verify_private_access(connection, target=target, role="runtime")
            assert queries == ["SELECT current_setting('search_path') AS path"]


@native
def test_warm_pool_does_not_cache_privileges(db):
    _, owner, target = db
    pool = pool_for(target, "runtime")
    try:
        pool.open()
        owner.execute("GRANT SELECT ON astarter_private.sessions TO astarter_private_runtime")
        with pytest.raises(AccessRejected, match="PRIVATE_COLUMN_PRIVILEGE"):
            with pool.transaction():
                pytest.fail("DRIFT_REACHED_BUSINESS")
        owner.execute("REVOKE SELECT ON astarter_private.sessions FROM astarter_private_runtime")
        with pool.transaction():
            pass
    finally:
        pool.close()


@native
def test_two_role_service_startup_has_bounded_calls_then_anonymous_denial_has_none(db, monkeypatch):
    _, _, target = db
    urls = [make_conninfo(host=target.host, port=target.port, dbname=target.database,
                         user=getattr(target, role), sslmode="disable", passfile="/dev/null")
            for role in ("runtime", "issuer")]
    config = PrivateServiceConfig(
        target, lease(target, int(time.time() * 1000) + 120000),
        *urls, "synthetic-runtime-" + "r" * 40, "synthetic-issuer-" + "i" * 40,
    )
    calls = []
    original = Connection.execute

    def observed(connection, query, *args, **kwargs):
        calls.append(1)
        return original(connection, query, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Connection, "execute", observed)
        with TestClient(create_private_service(config)) as client:
            assert len(calls) == 24
            response = client.post("/internal/private/v1/lease", json={})
            assert response.status_code == 401 and len(calls) == 24


@native
def test_temp_shadow_view_is_not_evaluated_before_original_ddl_rejection(db):
    pg, owner, target = db
    owner.execute(sql.SQL("GRANT TEMP ON DATABASE {} TO {}").format(
        sql.Identifier(target.database), sql.Identifier(target.runtime)))
    owner.execute("CREATE SEQUENCE public.access_rejection_marker")
    owner.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(
        sql.Identifier(target.runtime)))
    owner.execute(sql.SQL("GRANT USAGE ON SEQUENCE public.access_rejection_marker TO {}").format(
        sql.Identifier(target.runtime)))
    with pg.connect(user=target.runtime, dbname=target.database) as connection:
        connection.execute(
            "CREATE TEMP VIEW pg_class AS SELECT c.oid,c.relnamespace,c.relname,"
            "CASE WHEN nextval('public.access_rejection_marker')>0 THEN c.relkind "
            "ELSE 'z'::\"char\" END AS relkind FROM pg_catalog.pg_class c"
        )
        before = owner.execute(
            "SELECT last_value,is_called FROM public.access_rejection_marker"
        ).fetchone()
        with pytest.raises(AccessRejected, match="^PRIVATE_DDL_PRIVILEGE$"):
            with connection.transaction():
                connection.execute("SET LOCAL search_path=pg_catalog")
                verify_private_access(connection, target=target, role="runtime")
        assert owner.execute(
            "SELECT last_value,is_called FROM public.access_rejection_marker"
        ).fetchone() == before == {"last_value": 1, "is_called": False}
