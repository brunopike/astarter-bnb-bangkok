"""Explicit PUBLIC owner install and per-transaction access checks; no target discovery."""

from importlib.resources import files
from typing import Any

from psycopg import Connection

from stark_trading_os.control.public_data_policy import WEIGHT, PolicySnapshot, ProviderPolicy
from stark_trading_os.control.public_data_store import StoredPublicData, _state
from stark_trading_os.integrations.public_data.models import Mode

from .access import AccessRejected, _catalog_digest_sql
from .synthetic_migration import TargetProfile, profile_pins, sql_statements

# Captured from a separate pristine local PG17 oracle, never learned from target metadata.
PUBLIC_CATALOG_PIN = "8f069dff2cba1838751b49aeead0300d6991aca1cb25dd8feff5d36ea42b920b"
# Separate pristine Neon oracle, same DDL; includes Neon's cloud_admin default ACL.
PUBLIC_NEON_CATALOG_PIN = "103f8da57ebe88e4a4ae5796fa24f7fab6f4615f08e72565982454b08e04a5b6"
UPDATES = {
    "snapshots": {"revision", "fetched_at_ms", "refresh_at_ms", "payload_json", "last_good_json"},
    "budgets": {
        "day",
        "reserved",
        "total_reserved",
        "last_wall_ms",
        "next_at_ms",
        "epoch",
        "active_request",
    },
    "attempts": {"state", "revision", "deadline_ms"},
}


def _public_digest_sql() -> str:
    # Preserve the private PG2 catalog contract; bind PUBLIC's own schema ACL as well.
    return _catalog_digest_sql().replace(
        "WHERE n.nspname='pg1_control' AND a.grantee<>n.nspowner",
        "WHERE n.nspname='public_data' AND a.grantee<>n.nspowner",
    )


def catalog_digest(connection: Connection[Any]) -> str:
    row = connection.execute(_public_digest_sql()).fetchone()
    assert row is not None
    return str(row["digest"] if isinstance(row, dict) else row[0])


def public_sql() -> str:
    return files(__package__).joinpath("public_schema_v1.sql").read_text(encoding="utf-8")


def public_profile_pin(profile: TargetProfile, *, empty: bool = False) -> str:
    if type(profile) is not TargetProfile:
        raise AccessRejected("PUBLIC_PROFILE_UNVERIFIED")
    if empty:
        return profile_pins(profile)[0]
    return (PUBLIC_CATALOG_PIN if profile is TargetProfile.LOCAL_PG17
            else PUBLIC_NEON_CATALOG_PIN)


def install_public(connection: Connection[Any], *,
                   profile: TargetProfile = TargetProfile.LOCAL_PG17) -> None:
    """Owner-only, atomic new dedicated database install; replay never rewrites data."""
    pin = public_profile_pin(profile)
    with connection.transaction():
        connection.execute("SET LOCAL search_path=pg_catalog")
        version = connection.execute("SHOW server_version_num").fetchone()
        assert version is not None
        number = next(iter(version.values())) if isinstance(version, dict) else version[0]
        if int(number) // 10000 != 17:
            raise AccessRejected("PUBLIC_PG17_REQUIRED")
        exists = connection.execute(
            "SELECT 1 FROM pg_namespace WHERE nspname='public_data'"
        ).fetchone()
        if exists:
            if catalog_digest(connection) != pin:
                raise AccessRejected("PUBLIC_CATALOG_MISMATCH")
            return
        if catalog_digest(connection) != public_profile_pin(profile, empty=True):
            raise AccessRejected("PUBLIC_EMPTY_CATALOG_MISMATCH")
        objects = connection.execute(
            "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname NOT IN ('pg_catalog','information_schema') "
            "AND n.nspname !~ '^pg_toast' LIMIT 1"
        ).fetchone()
        if objects:
            raise AccessRejected("PUBLIC_DEDICATED_DATABASE_REQUIRED")
        for role in ("public_data_read", "public_data_collect"):
            row = connection.execute(
                "SELECT rolcanlogin OR rolsuper OR rolcreatedb OR "
                "rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=%s",
                (role,),
            ).fetchone()
            if row is None or bool(next(iter(row.values())) if isinstance(row, dict) else row[0]):
                raise AccessRejected("PUBLIC_CAPABILITY_ROLE")
        for statement in sql_statements(public_sql()):
            connection.execute(statement)
        if catalog_digest(connection) != pin:
            raise AccessRejected("PUBLIC_CATALOG_MISMATCH")


def seed_public(
    connection: Connection[Any],
    *,
    mode: Mode,
    policies: tuple[ProviderPolicy, ...],
    total_caps: dict[str, int],
    valid_until_ms: int,
    snapshots: dict[str, StoredPublicData] | None = None,
    legacy: dict[str, PolicySnapshot] | None = None,
    profile: TargetProfile = TargetProfile.LOCAL_PG17,
) -> None:
    """One-time explicit owner seed/import. No filesystem reads, resets or partial migrations.

    Legacy reservations are retained as at least total_reserved; operator must supply
    a conservative total cap reflecting any earlier-day usage not present in SQLite.
    Unresolved legacy work adds a full recovery hold without refunding its charge.
    """
    pin = public_profile_pin(profile)
    if (
        mode not in {"offline_fixture", "live_readonly"}
        or len(policies) != 3
        or {p.scope for p in policies} != set(WEIGHT)
        or set(total_caps) != set(WEIGHT)
        or type(valid_until_ms) is not int
        or not 0 < valid_until_ms <= 253402300799999
        or any(type(n) is not int or not 0 <= n <= 1000000000 for n in total_caps.values())
        or (legacy is not None and set(legacy) != set(WEIGHT))
    ):
        raise AccessRejected("PUBLIC_SEED_INVALID")
    with connection.transaction():
        connection.execute("SET LOCAL search_path=pg_catalog")
        if catalog_digest(connection) != pin:
            raise AccessRejected("PUBLIC_CATALOG_MISMATCH")
        connection.execute(
            "LOCK TABLE public_data.budgets, public_data.snapshots IN EXCLUSIVE MODE"
        )
        if connection.execute(
            "SELECT 1 FROM public_data.budgets WHERE mode=%s", (mode,)
        ).fetchone():
            raise AccessRejected("PUBLIC_ALREADY_INITIALIZED")
        row = connection.execute(
            "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms"
        ).fetchone()
        assert row is not None
        now = int(row["ms"] if isinstance(row, dict) else row[0])
        if valid_until_ms <= now:
            raise AccessRejected("PUBLIC_BUDGET_EXPIRED")
        for p in policies:
            old = legacy[p.scope] if legacy else PolicySnapshot(0, 0, 0, 0, False)
            deadline = max(
                old.next_at_ms,
                old.last_wall_ms,
                now + max(60000, p.interval_ms, old.next_at_ms - old.last_wall_ms)
                if old.pending
                else 0,
            )
            connection.execute(
                "INSERT INTO public_data.budgets "
                "(scope,mode,daily_cap,total_cap,valid_until_ms,interval_ms,weight,day,reserved,"
                "total_reserved,last_wall_ms,next_at_ms) VALUES "
                "(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    p.scope,
                    mode,
                    p.daily_cap,
                    total_caps[p.scope],
                    valid_until_ms,
                    p.interval_ms,
                    WEIGHT[p.scope],
                    old.day,
                    old.reserved_weight,
                    old.reserved_weight,
                    max(old.last_wall_ms, now) if old.pending else old.last_wall_ms,
                    deadline,
                ),
            )
        for resource, old_state in (snapshots or {}).items():
            s = _state(
                resource,
                mode,
                old_state.payload,
                old_state.last_good,
                old_state.fetched_at_ms,
                old_state.refresh_at_ms,
                old_state.revision,
            )
            connection.execute(
                "INSERT INTO public_data.snapshots "
                "(resource,mode,revision,fetched_at_ms,refresh_at_ms,payload_json,last_good_json) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (
                    resource,
                    mode,
                    s.revision,
                    s.fetched_at_ms,
                    s.refresh_at_ms,
                    s.payload.model_dump_json(),
                    s.last_good.model_dump_json() if s.last_good else None,
                ),
            )


def verify_public_access(
    connection: Connection[dict[str, Any]], *, writable: bool, profile: TargetProfile
) -> None:
    pin = public_profile_pin(profile)
    if profile is TargetProfile.NEON_PG17_V1 and not connection.pgconn.ssl_in_use:
        raise AccessRejected("PUBLIC_TLS_REQUIRED")
    statements = (
        "SELECT current_user AS name,session_user AS login,rolcanlogin,"
        "rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS unsafe, "
        "current_setting('server_version_num')::int/10000 AS major "
        "FROM pg_roles WHERE rolname=current_user",
        "SELECT rolname,rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR "
        "rolbypassrls OR rolcanlogin AS unsafe FROM pg_roles WHERE rolname<>current_user "
        "AND pg_has_role(current_user,oid,'MEMBER')",
        "SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member "
        "WHERE r.rolname=current_user AND m.admin_option",
        "SELECT NOT has_database_privilege(current_database(),'CONNECT') OR "
        "has_database_privilege(current_database(),'CREATE') OR "
        "has_database_privilege(current_database(),'TEMP') OR EXISTS(SELECT 1 FROM "
        "(VALUES ('CREATE'),('TEMP'),('CONNECT')) p(priv) WHERE "
        "has_database_privilege(current_database(),p.priv||' WITH GRANT OPTION')) OR "
        "has_schema_privilege('public','CREATE') OR "
        "has_schema_privilege('public_data','CREATE') OR "
        "has_schema_privilege('public_data','USAGE WITH GRANT OPTION') AS unsafe",
        "SELECT n.nspname,c.relname,a.attname,p.priv,has_column_privilege(c.oid,a.attnum,p.priv) "
        "AS allowed,has_column_privilege(c.oid,a.attnum,p.priv||' WITH GRANT OPTION') AS grantable "
        "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped "
        "CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(priv) "
        "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' "
        "AND c.relkind='r'",
        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "CROSS JOIN (VALUES ('DELETE'),('TRUNCATE'),('TRIGGER'),('MAINTAIN')) p(priv) "
        "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' "
        "AND c.relkind='r' AND has_table_privilege(c.oid,p.priv) LIMIT 1",
        _public_digest_sql(),
    )
    cursor = connection.execute(";".join(statements), prepare=False)
    results = [cursor.fetchall()]
    while cursor.nextset():
        results.append(cursor.fetchall())
    if len(results) != 7:
        raise AccessRejected("PUBLIC_ACCESS_RESULTS")
    roles, members, admin, ddl, columns, forbidden, digest = results
    cap = "public_data_collect" if writable else "public_data_read"
    if (
        len(roles) != 1
        or roles[0]["name"] != roles[0]["login"]
        or not roles[0]["rolcanlogin"]
        or roles[0]["unsafe"]
        or roles[0]["major"] != 17
        or {m["rolname"] for m in members} != {cap}
        or any(m["unsafe"] for m in members)
        or admin
        or len(ddl) != 1
        or ddl[0]["unsafe"]
        or forbidden
        or len(digest) != 1
        or digest[0]["digest"] != pin
    ):
        raise AccessRejected("PUBLIC_ACCESS_REJECTED")
    for row in columns:
        table, column, privilege = row["relname"], row["attname"], row["priv"]
        expected = row["nspname"] == "public_data" and (
            (privilege == "SELECT" and (table == "snapshots" or writable))
            or (writable and privilege == "INSERT" and table in {"snapshots", "attempts"})
            or (writable and privilege == "UPDATE" and column in UPDATES.get(table, set()))
        )
        if row["allowed"] != expected or row["grantable"]:
            raise AccessRejected("PUBLIC_COLUMN_PRIVILEGE")
