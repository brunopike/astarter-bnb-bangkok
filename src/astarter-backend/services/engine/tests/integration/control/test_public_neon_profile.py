"""PUBLIC profile qualification and actual role drift in owned local PG only."""

# ruff: noqa: F811 -- imported shared pytest fixture.
import pytest
from psycopg import sql

from stark_trading_os.control.postgres import public_access as access
from stark_trading_os.control.postgres.access import AccessRejected
from tests.integration.control.test_public_pg import pool, public_db  # noqa: F401


@pytest.mark.parametrize("privilege", ["TEMPORARY", "CONNECT WITH GRANT OPTION"])
def test_database_privilege_drift_rejected(public_db, privilege):
    owner, writer, _ = public_db
    db = owner.info.dbname
    owner.execute(sql.SQL("GRANT {} ON DATABASE {} TO r22_collector").format(
        sql.SQL(privilege.split(" WITH")[0]), sql.Identifier(db)
    ) + sql.SQL(" WITH GRANT OPTION" if " WITH" in privilege else ""))
    p = pool(writer)
    try:
        with pytest.raises(AccessRejected, match="PUBLIC_ACCESS_REJECTED"):
            p.open()
    finally:
        p.close()


def test_owner_empty_catalog_guard_rejects_extra_function(public_db):
    owner, _, _ = public_db
    # Existing full catalog replay must reject unrelated objects as well.
    owner.execute("CREATE FUNCTION public.extra() RETURNS int LANGUAGE sql AS 'SELECT 1'")
    with pytest.raises(AccessRejected, match="CATALOG_MISMATCH"):
        access.install_public(owner)


def test_wrong_profile_seed_and_replay_leave_existing_rows_unchanged(public_db):
    from stark_trading_os.control.postgres.synthetic_migration import TargetProfile
    from tests.integration.control.test_public_pg import seed
    owner, _, _ = public_db
    seed(owner)
    before = owner.execute('SELECT * FROM public_data.budgets ORDER BY scope').fetchall()
    with pytest.raises(AccessRejected, match='CATALOG_MISMATCH'):
        access.install_public(owner, profile=TargetProfile.NEON_PG17_V1)
    from stark_trading_os.control.public_data_policy import MIN_INTERVAL, ProviderPolicy
    with pytest.raises(AccessRejected, match='CATALOG_MISMATCH'):
        access.seed_public(owner, mode='offline_fixture',
            policies=tuple(ProviderPolicy(s, 5, n) for s, n in MIN_INTERVAL.items()),
            total_caps={s:5 for s in MIN_INTERVAL}, valid_until_ms=253402300799999,
            profile=TargetProfile.NEON_PG17_V1)
    assert owner.execute('SELECT * FROM public_data.budgets ORDER BY scope').fetchall() == before


def test_empty_catalog_guard_runs_before_installation(public_db):
    owner, _, _ = public_db
    owner.execute('DROP SCHEMA public_data CASCADE')  # owned disposable fixture only
    owner.execute("CREATE FUNCTION public.extra() RETURNS int LANGUAGE sql AS 'SELECT 1'")
    with pytest.raises(AccessRejected, match='EMPTY_CATALOG_MISMATCH'):
        access.install_public(owner)
    missing = owner.execute("SELECT 1 FROM pg_namespace WHERE nspname='public_data'").fetchone()
    assert missing is None


def test_actual_plaintext_connection_cannot_impersonate_neon(public_db):
    from stark_trading_os.control.postgres.synthetic_migration import TargetProfile
    owner, _, _ = public_db
    assert not owner.pgconn.ssl_in_use
    with pytest.raises(AccessRejected, match='PUBLIC_TLS_REQUIRED'):
        access.verify_public_access(owner, writable=True, profile=TargetProfile.NEON_PG17_V1)


def test_database_acl_revocation_checked_on_reused_connection(public_db):
    owner, writer, _ = public_db
    p = pool(writer)
    try:
        p.open()
        owner.execute(sql.SQL('REVOKE CONNECT ON DATABASE {} FROM PUBLIC').format(
            sql.Identifier(owner.info.dbname)))
        with pytest.raises(AccessRejected, match='PUBLIC_ACCESS_REJECTED'):
            with p.transaction():
                pytest.fail('transaction body must not run')
    finally:
        p.close()


def test_neon_oracle_semantics_reproduced_independently(public_db):
    """Replay only the documented Neon empty default ACL on a disposable local DB."""
    import os
    import time

    import psycopg

    from stark_trading_os.control.postgres.synthetic_migration import TargetProfile
    from stark_trading_os.control.public_data_policy import MIN_INTERVAL, ProviderPolicy

    owner, _, _ = public_db
    owner.execute('DROP SCHEMA public_data CASCADE')
    with psycopg.connect(host=os.environ['PG2_TEST_SOCKET'], port=55439,
                        user='pg1_owner', dbname=owner.info.dbname, autocommit=True) as admin:
        for name in ('cloud_admin', 'neon_superuser'):
            if not admin.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (name,)).fetchone():
                admin.execute(sql.SQL('CREATE ROLE {} NOLOGIN').format(sql.Identifier(name)))
        admin.execute('ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public '
                      'GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,MAINTAIN ON TABLES '
                      'TO neon_superuser WITH GRANT OPTION')
        admin.execute('ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public '
                      'GRANT SELECT,UPDATE,USAGE ON SEQUENCES '
                      'TO neon_superuser WITH GRANT OPTION')
    profile = TargetProfile.NEON_PG17_V1
    with owner.transaction():
        owner.execute('SET LOCAL search_path=pg_catalog')
        assert access.catalog_digest(owner) == access.public_profile_pin(profile, empty=True)
    access.install_public(owner, profile=profile)
    access.install_public(owner, profile=profile)
    access.seed_public(owner, profile=profile, mode='offline_fixture',
        policies=tuple(ProviderPolicy(s, 3, n) for s, n in MIN_INTERVAL.items()),
        total_caps={s:3 for s in MIN_INTERVAL}, valid_until_ms=time.time_ns()//1000000+86400000)
    assert owner.execute('SELECT count(*) FROM public_data.budgets').fetchone()[0] == 3
    with owner.transaction():
        owner.execute('SET LOCAL search_path=pg_catalog')
        assert access.catalog_digest(owner) == access.PUBLIC_NEON_CATALOG_PIN
