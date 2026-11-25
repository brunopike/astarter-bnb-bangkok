"""Explicit PRIVATE schema versions; local forward migration never discovers a target."""

from dataclasses import replace

import pytest
from psycopg import sql

from stark_trading_os.control.postgres import private_research_migration as migration
from stark_trading_os.control.postgres import private_ui_migration as ui
from stark_trading_os.control.postgres.access import AccessRejected
from stark_trading_os.control.postgres.private_research_access import verify_private_access
from stark_trading_os.control.postgres.private_ui_migration import upgrade_private_ui
from tests.unit.control.postgres import test_private_research_migration as fixtures
from tests.unit.control.postgres.test_private_research_migration import db as db
from tests.unit.control.postgres.test_private_research_migration import native
from tests.unit.control.postgres.test_private_research_migration import pg as pg
from tests.unit.control.postgres.test_private_research_pool import target
from tests.unit.control.postgres.test_private_ui_identity import _preserved, _rows


def test_schema_version_is_explicit_and_old_configuration_stays_v1():
    old = target()
    assert getattr(old, "schema_version", None) == 1
    new = replace(old, schema_version=2)
    assert new.schema_version == 2 and old.schema_version == 1
    assert migration.expected_metadata(new)["schema_version"] == 2
    assert migration.expected_metadata(old)["schema_version"] == 1


@pytest.mark.parametrize("version", [True, False, 1.0, 0, 4, "2"])
def test_unknown_or_coerced_schema_version_rejected_cold(version):
    with pytest.raises(AccessRejected):
        replace(target(), schema_version=version)


def test_neon_v2_uses_the_independently_captured_oracle_pin_without_io():
    assert migration.private_profile_pins(migration.TargetProfile.NEON_PG17_V1, 2) == (
        migration.NEON_EMPTY_PIN,
        "d5242c0c184e888c7b8e23c305036e3c3c679af814ffaca430fd04b6f7fbcd19",
    )


@native
def test_operator_before_commit_gate_aborts_ddl_and_preserves_old_rows(db):
    _, owner, old = db
    fixtures.accounting(db, "a")
    before, old_catalog = _rows(owner), migration.private_catalog_digest(owner)
    new = replace(old, schema_version=2)
    observed = []

    def stop():
        observed.append(migration.private_catalog_digest(owner))
        raise RuntimeError("SYNTHETIC_OPERATOR_DEADLINE")

    with pytest.raises(RuntimeError, match="SYNTHETIC_OPERATOR_DEADLINE"):
        upgrade_private_ui(owner, target=new, before_commit=stop)
    assert observed == [migration.private_profile_pins(new.profile, 2)[1]]
    assert migration.private_catalog_digest(owner) == old_catalog
    assert _rows(owner) == before
    assert owner.execute("SELECT schema_version FROM astarter_private.metadata").fetchone() == {
        "schema_version": 1
    }
    committed = []
    upgrade_private_ui(owner, target=new, before_commit=lambda: committed.append(True))
    _preserved(before, owner)
    upgrade_private_ui(owner, target=new, before_commit=lambda: committed.append(True))
    assert committed == [True]


@native
@pytest.mark.parametrize("unsafe_role", ["owner", "capability"])
def test_forward_upgrade_reuses_owner_and_capability_identity_gate(db, unsafe_role):
    cluster, owner, old = db
    role = old.owner if unsafe_role == "owner" else migration.CAPABILITIES["runtime"]
    setting, reset = ("CREATEDB", "NOCREATEDB") if unsafe_role == "owner" else ("LOGIN", "NOLOGIN")
    expected = "PRIVATE_OWNER_IDENTITY" if unsafe_role == "owner" else "PRIVATE_CAPABILITY_REJECTED"
    with cluster.connect() as admin:
        admin.execute(sql.SQL("ALTER ROLE {} " + setting).format(sql.Identifier(role)))
    try:
        before = migration.private_catalog_digest(owner)
        with pytest.raises(AccessRejected, match=expected):
            upgrade_private_ui(owner, target=replace(old, schema_version=2))
        assert migration.private_catalog_digest(owner) == before
        assert owner.execute("SELECT schema_version FROM astarter_private.metadata").fetchone() == {
            "schema_version": 1
        }
    finally:
        with cluster.connect() as admin:
            admin.execute(sql.SQL("ALTER ROLE {} " + reset).format(sql.Identifier(role)))


@native
def test_exact_neon_v2_catalog_and_mutated_acl_on_new_owned_pg_only(db):
    cluster, owner, old = db
    target = replace(old, schema_version=2)
    upgrade_private_ui(owner, target=target)
    assert migration.private_catalog_digest(owner) == ui.LOCAL_UI_PIN
    with cluster.connect() as admin:
        admin.execute("CREATE ROLE cloud_admin SUPERUSER LOGIN")
        admin.execute("CREATE ROLE neon_superuser NOLOGIN")
    with cluster.connect(user="cloud_admin", dbname=target.database) as platform:
        platform.execute(
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT "
            "DELETE,INSERT,MAINTAIN,SELECT,TRUNCATE,UPDATE ON TABLES "
            "TO neon_superuser WITH GRANT OPTION"
        )
        platform.execute(
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT "
            "SELECT,UPDATE,USAGE ON SEQUENCES TO neon_superuser WITH GRANT OPTION"
        )
        observed = migration.private_catalog_digest(owner)
        assert observed == ui.NEON_UI_PLATFORM_PIN
        assert ui.ui_catalog_matches(migration.TargetProfile.NEON_PG17_V1, observed)
        assert not ui.ui_catalog_matches(migration.TargetProfile.LOCAL_PG17, observed)
        with cluster.connect(user=target.runtime, dbname=target.database) as runtime:
            with pytest.raises(AccessRejected, match="^PRIVATE_CATALOG_MISMATCH$"):
                with runtime.transaction():
                    runtime.execute("SET LOCAL search_path=pg_catalog")
                    verify_private_access(runtime, target=target, role="runtime")
        platform.execute(
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE GRANT OPTION FOR "
            "SELECT ON SEQUENCES FROM neon_superuser"
        )
        assert not ui.ui_catalog_matches(
            migration.TargetProfile.NEON_PG17_V1, migration.private_catalog_digest(owner)
        )
        platform.execute(
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT "
            "SELECT ON SEQUENCES TO neon_superuser WITH GRANT OPTION"
        )
        assert migration.private_catalog_digest(owner) == observed
        platform.execute(
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC"
        )
        assert not ui.ui_catalog_matches(
            migration.TargetProfile.NEON_PG17_V1, migration.private_catalog_digest(owner)
        )
        platform.execute(
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM PUBLIC"
        )
        assert migration.private_catalog_digest(owner) == observed
    owner.execute("ALTER TABLE astarter_private.metadata ADD COLUMN fixture_probe boolean")
    assert not ui.ui_catalog_matches(
        migration.TargetProfile.NEON_PG17_V1, migration.private_catalog_digest(owner)
    )
