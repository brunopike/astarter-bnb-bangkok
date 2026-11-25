"""PRIVATE native role/catalog handshake; session digest, not a tenant header, scopes RLS."""

from typing import Any, Literal

from psycopg import Connection
from psycopg.pq import TransactionStatus

from .access import AccessRejected
from .private_research_migration import (
    CAPABILITIES,
    PrivateTarget,
    check_connection,
    check_metadata,
    private_catalog_digest,
    private_profile_pins,
    private_resources,
)

PrivateRole = Literal["runtime", "issuer", "cost"]
READ_TABLES = {
    "runtime": {"metadata", "leases", "global_budget", "policies", "requests"},
    "issuer": {"metadata", "challenges", "sessions"},
    "cost": {"metadata", "cost_events"},
}
ISSUER_UPDATES = {
    "challenges": {
        "address",
        "chain_id",
        "message",
        "prepared_at_ms",
        "claim_digest",
        "consumed_at_ms",
        "revoked_at_ms",
    },
    "sessions": {"revoked_at_ms"},
}


def _read_pair(
    connection: Connection[dict[str, Any]], statements: tuple[str, str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Only batch reads sharing one guard, so earlier rejection cannot be bypassed."""
    cursor = connection.execute(";".join(statements), prepare=False)
    results = [cursor.fetchall()]
    while cursor.nextset():
        results.append(cursor.fetchall())
    if len(results) != 2:
        raise AccessRejected("PRIVATE_ACCESS_RESULTS")
    return results[0], results[1]


def verify_private_access(
    connection: Connection[dict[str, Any]], *, target: PrivateTarget, role: PrivateRole
) -> None:
    if type(role) is not str or role not in CAPABILITIES:
        raise AccessRejected("PRIVATE_ACCESS_ROLE")
    check_connection(connection, target, getattr(target, role))
    private_resources()
    if connection.pgconn.transaction_status != TransactionStatus.INTRANS:
        raise AccessRejected("PRIVATE_ACCESS_TRANSACTION")
    settings = connection.execute("SELECT current_setting('search_path') AS path").fetchone()
    if settings != {"path": "pg_catalog"}:
        raise AccessRejected("PRIVATE_ACCESS_SEARCH_PATH")
    user = getattr(target, role)
    identity = connection.execute(
        "SELECT current_database() AS db,current_user AS role,session_user AS login,"
        "r.rolcanlogin AND r.rolinherit AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole "
        "OR r.rolreplication OR r.rolbypassrls) AND r.rolconfig IS NULL AND r.rolconnlimit=-1 "
        "AND r.rolvaliduntil IS NULL AS safe,"
        "current_setting('server_version_num')::int/10000 AS major "
        "FROM pg_roles r WHERE rolname=current_user"
    ).fetchone()
    if identity != dict(db=target.database, role=user, login=user, safe=True, major=17):
        raise AccessRejected("PRIVATE_APP_IDENTITY")
    parents, admins = _read_pair(connection, (
        "SELECT rolname,rolcanlogin OR rolsuper OR rolcreatedb OR "
        "rolcreaterole OR rolreplication "
        "OR rolbypassrls OR rolconfig IS NOT NULL AS unsafe FROM pg_roles "
        "WHERE rolname<>current_user AND pg_has_role(current_user,oid,'MEMBER')",
        "SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member "
        "WHERE r.rolname=current_user AND m.admin_option",
    ))
    if parents != [{"rolname": CAPABILITIES[role], "unsafe": False}] or admins:
        raise AccessRejected("PRIVATE_ROLE_MEMBERSHIP")
    privileges = connection.execute(
        "SELECT has_database_privilege(current_database(),'CONNECT') AS connected,"
        "has_schema_privilege('astarter_private','USAGE') AS usable,"
        "has_database_privilege(current_database(),'CREATE') OR "
        "has_database_privilege(current_database(),'TEMP') OR EXISTS(SELECT 1 FROM "
        "(VALUES ('CREATE'),('TEMP'),('CONNECT')) p(priv) WHERE "
        "has_database_privilege(current_database(),p.priv||' WITH GRANT OPTION')) OR "
        "EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT IN "
        "('pg_catalog','information_schema') "
        "AND n.nspname !~ '^pg_toast' AND (has_schema_privilege(n.oid,'CREATE') OR "
        "has_schema_privilege(n.oid,'USAGE WITH GRANT OPTION'))) AS unsafe"
    ).fetchone()
    if privileges != {"connected": True, "usable": True, "unsafe": False}:
        raise AccessRejected("PRIVATE_DDL_PRIVILEGE")
    columns = connection.execute(
        "SELECT n.nspname,c.relname,a.attname,p.priv,has_column_privilege(c.oid,a.attnum,p.priv) "
        "AS allowed,has_column_privilege(c.oid,a.attnum,p.priv||' WITH "
        "GRANT OPTION') AS grantable "
        "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped "
        "CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(priv) "
        "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' "
        "AND c.relkind='r'"
    ).fetchall()
    for column in columns:
        table, privilege = column["relname"], column["priv"]
        expected = column["nspname"] == "astarter_private" and (
            (privilege == "SELECT" and table in (READ_TABLES[role] | (
                {"notification_preferences", "notification_inbox", "workspace_preferences",
                 "ui_commands"} if role == "runtime" and target.schema_version in (2, 3) else set()
            ) | (
                {"draft_versions", "draft_heads", "draft_commands"}
                if role == "runtime" and target.schema_version == 3 else set()
            )))
            or (role == "issuer" and privilege == "INSERT" and table in {"challenges", "sessions"})
            or (
                role == "issuer"
                and privilege == "UPDATE"
                and column["attname"] in ISSUER_UPDATES.get(table, set())
            )
        )
        if (role == "runtime" and target.schema_version in (2, 3)
                and column["nspname"] == "astarter_private"):
            expected |= privilege == "INSERT" and table in {
                "notification_preferences", "workspace_preferences", "ui_commands",
            }
            expected |= privilege == "UPDATE" and column["attname"] in {
                "notification_preferences": {
                    "revision", "updated_at_ms", "inapp", "events", "telegram_enabled",
                    "email_enabled",
                },
                "workspace_preferences": {
                    "revision", "updated_at_ms", "preferences", "drafts", "selected_draft_id",
                },
                "notification_inbox": {"read_at_ms"},
            }.get(table, set())
            if target.schema_version == 3:
                expected |= privilege == "INSERT" and table in {
                    "draft_versions", "draft_heads", "draft_commands",
                }
                expected |= privilege == "UPDATE" and table == "draft_heads" and (
                    column["attname"] == "revision")
        if column["allowed"] != expected or column["grantable"]:
            raise AccessRejected("PRIVATE_COLUMN_PRIVILEGE")
    dangerous, functions = _read_pair(connection, (
        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "CROSS JOIN (VALUES ('DELETE'),('TRUNCATE'),('TRIGGER'),('MAINTAIN')) p(priv) "
        "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' "
        "AND c.relkind='r' AND has_table_privilege(c.oid,p.priv) LIMIT 1",
        "SELECT n.nspname,p.oid::regprocedure::text AS signature,"
        "has_function_privilege(p.oid,'EXECUTE') AS allowed,"
        "has_function_privilege(p.oid,'EXECUTE WITH GRANT OPTION') AS grantable "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
        "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'",
    ))
    allowed_functions = {
        "runtime": {
            "astarter_private.resolve_session(text,text)",
            "astarter_private.claim_research(text,text,text,text,text,text,numeric,numeric)",
            "astarter_private.finish_research(text,text,text,text,text,text,numeric,jsonb,text)",
        },
        "issuer": set(),
        "cost": {"astarter_private.settle_cost(text,text,text,text,numeric,numeric)"},
    }
    if role == "runtime" and target.schema_version in (2, 3):
        allowed_functions[role].add("astarter_private.ui_workspace_valid(jsonb,jsonb,text)")
        allowed_functions[role].add("astarter_private.ui_authorized(text,text,text)")
    for function in functions:
        expected = function["signature"] in allowed_functions[role]
        if function["allowed"] != expected or function["grantable"]:
            raise AccessRejected("PRIVATE_FUNCTION_PRIVILEGE")
    if dangerous:
        raise AccessRejected("PRIVATE_CATALOG_MISMATCH")
    digest = private_catalog_digest(connection)
    if target.schema_version == 2:
        from .private_ui_migration import ui_catalog_matches

        matches = ui_catalog_matches(target.profile, digest)
    else:
        matches = digest == private_profile_pins(target.profile, target.schema_version)[1]
    if not matches:
        raise AccessRejected("PRIVATE_CATALOG_MISMATCH")
    check_metadata(connection, target)
