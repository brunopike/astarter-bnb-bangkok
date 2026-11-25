"""Q08 stub access v1: sealed local synthetic upgrades, never a cloud bootstrap.

Same trusted-backend/cooperative-owner boundary as PG2, not RLS or hostile DBA
attestation. No connection, credentials, target discovery or data repair on import.
"""

import re
from hashlib import sha256
from importlib.resources import files
from typing import Any

from psycopg import Connection

from .access import (
    APPEND_TABLES,
    PG2_CATALOG_PINS,
    READ_TABLES,
    AccessRejected,
)
from .access import (
    RepositoryAccessContract as RepositoryAccessContract,
)
from .synthetic_migration import (
    CATALOG_RESOURCE_SHA256,
    MAX_BYTES,
    MAX_ROWS,
    Snapshot,
    Table,
    TargetProfile,
    catalog_rows_sql,
    frame,
    literal,
    metadata_sql,
    schema_sql,
    sql_statements,
    transaction_settings,
    verification_sql,
)

# Captured only from a separate pristine owned local PG17 oracle, never target metadata.
RESEARCH_CATALOG_PIN = "a95a96d5e81c2e9dc60af2d4d9b8ba77ca5b11177e5a4839b440566890101e67"
RESEARCH_RESOURCE_SHA256 = "e5c7dda7a2bb124dc35f314b6ed04cb7df45b56ac31593bdf67671542530aaac"
RESEARCH_TABLES = frozenset(
    {
        "research_jobs",
        "research_role_attempts",
        "research_artifacts",
        "research_consumers",
        "research_budget_scopes",
        "research_reservations",
        "research_events_outbox",
    }
)
UPDATE_COLUMNS = {
    "research_metadata": frozenset({"singleton"}),
    "research_jobs": frozenset(
        {"state", "version", "updated_at_ms", "resume_kind", "resume_event_id", "not_before_ms"}
    ),
    "research_role_attempts": frozenset(
        {
            "state",
            "worker_id",
            "claim_id",
            "owner_epoch",
            "lease_until_ms",
            "permit_id",
            "response_id",
            "response_sha256",
            "version",
            "updated_at_ms",
        }
    ),
    "research_budget_scopes": frozenset(
        {"reserved_atoms", "spent_atoms", "unknown_atoms", "version", "updated_at_ms"}
    ),
    "research_reservations": frozenset({"state", "version", "updated_at_ms"}),
    "research_events_outbox": frozenset(
        {
            "delivery_state",
            "delivery_owner",
            "delivery_epoch",
            "delivery_attempts",
            "delivery_lease_until_ms",
            "delivery_ack_sha256",
            "version",
            "updated_at_ms",
        }
    ),
}


def research_profile_pin(target_profile: TargetProfile) -> str:
    if type(target_profile) is not TargetProfile:
        raise AccessRejected("Q08_PROFILE")
    if target_profile is not TargetProfile.LOCAL_PG17 or not re.fullmatch(
        "[0-9a-f]{64}", RESEARCH_CATALOG_PIN
    ):
        raise AccessRejected("Q08_PROFILE_UNVERIFIED")
    return RESEARCH_CATALOG_PIN


def research_resources() -> tuple[str, str]:
    package = files(__package__)
    schema = package.joinpath("research_schema_v1.sql").read_text(encoding="utf-8")
    access = package.joinpath("research_access_v1.sql").read_text(encoding="utf-8")
    if (
        sha256((schema + "\n--Q08-ACCESS--\n" + access).encode()).hexdigest()
        != RESEARCH_RESOURCE_SHA256
    ):
        raise AccessRejected("Q08_RESOURCE_MISMATCH")
    return schema, access


def research_catalog_rows_sql() -> str:
    # The frozen base inventories all namespaces but schema ACL only for pg1_control.
    # Add domain semantics and database/schema/type ACLs without changing the old query or pin.
    # Tagged identities keep a real role named "owner" distinct from the ownership marker.
    return (
        "SELECT v FROM ("
        + catalog_rows_sql()
        + ") base UNION ALL "
        + """
 SELECT json_build_array('q08_schema_acl',n.nspname,
 CASE WHEN a.grantor=n.nspowner THEN json_build_array('owner')
 ELSE json_build_array('role',a.grantor::regrole::text) END,
 CASE WHEN a.grantee=0 THEN json_build_array('public')
 WHEN a.grantee=n.nspowner THEN json_build_array('owner')
 ELSE json_build_array('role',a.grantee::regrole::text) END,a.privilege_type,a.is_grantable)::text
 FROM pg_namespace n CROSS JOIN LATERAL
 aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
 WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
 UNION ALL SELECT json_build_array('q08_domain',n.nspname,t.typname,
 bns.nspname,bt.typname,t.typtypmod,t.typndims,t.typnotnull,
 cns.nspname,co.collname,pg_get_expr(t.typdefaultbin,0),t.typdefault)::text
 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
 JOIN pg_type bt ON bt.oid=t.typbasetype JOIN pg_namespace bns ON bns.oid=bt.typnamespace
 LEFT JOIN pg_collation co ON co.oid=t.typcollation
 LEFT JOIN pg_namespace cns ON cns.oid=co.collnamespace
 WHERE t.typtype='d' AND n.nspname NOT IN ('pg_catalog','information_schema')
 AND n.nspname !~ '^pg_toast'
 UNION ALL SELECT json_build_array('q08_database_acl',
 CASE WHEN a.grantor=d.datdba THEN json_build_array('owner')
 ELSE json_build_array('role',a.grantor::regrole::text) END,
 CASE WHEN a.grantee=0 THEN json_build_array('public')
 WHEN a.grantee=d.datdba THEN json_build_array('owner')
 ELSE json_build_array('role',a.grantee::regrole::text) END,a.privilege_type,a.is_grantable)::text
 FROM pg_database d CROSS JOIN LATERAL
 aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
 WHERE d.datname=current_database()
 UNION ALL SELECT json_build_array('q08_type_acl',n.nspname,t.typname,
 CASE WHEN a.grantor=t.typowner THEN json_build_array('owner')
 ELSE json_build_array('role',a.grantor::regrole::text) END,
 CASE WHEN a.grantee=0 THEN json_build_array('public')
 WHEN a.grantee=t.typowner THEN json_build_array('owner')
 ELSE json_build_array('role',a.grantee::regrole::text) END,a.privilege_type,a.is_grantable)::text
 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace CROSS JOIN LATERAL
 aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) a
 WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
 """
    )


def _digest_sql() -> str:
    return (
        "SELECT encode(sha256(convert_to(coalesce(string_agg(v,E'\\n' "
        "ORDER BY v COLLATE \"C\"),''),'UTF8')),'hex') AS digest FROM ("
        + research_catalog_rows_sql()
        + ") q08_catalog"
    )


def research_catalog_digest(connection: Connection[Any]) -> str:
    row = connection.execute(_digest_sql()).fetchone()
    if row is None:
        raise AccessRejected("Q08_CATALOG_EMPTY")
    return str(row["digest"] if isinstance(row, dict) else row[0])


def _assert_sql(test: str, reason: str) -> str:
    return (
        f"DO $q08_check$ BEGIN IF ({test}) IS DISTINCT FROM TRUE THEN "
        f"RAISE EXCEPTION USING MESSAGE='{reason}'; END IF; END $q08_check$;"
    )


def _snapshot(source: Snapshot) -> None:
    names = set(re.findall(r"^CREATE TABLE ([a-z_][a-z0-9_]*) ", schema_sql(), re.M)) - {
        "pg1_metadata"
    }
    if (
        type(source) is not Snapshot
        or type(source.tables) is not tuple
        or len(source.tables) != 37
        or any(type(t) is not Table for t in source.tables)
        or {t.name for t in source.tables} != names
        or not re.fullmatch("[0-9a-f]{64}", source.source_sha256)
    ):
        raise AccessRejected("Q08_SNAPSHOT")
    count, size = 0, 0
    for table in source.tables:
        if type(table) is not Table or not table.columns or not table.ordering:
            raise AccessRejected("Q08_SNAPSHOT")
        if any(
            not re.fullmatch("[a-z_][a-z0-9_]*", name) or kind not in {"TEXT", "INTEGER", "BLOB"}
            for name, kind in table.columns
        ) or not set(table.ordering) <= {c[0] for c in table.columns}:
            raise AccessRejected("Q08_SNAPSHOT")
        count += len(table.rows)
        for row in table.rows:
            if len(row) != len(table.columns):
                raise AccessRejected("Q08_SNAPSHOT")
            size += sum(len(frame(v)) for v in row)
        if count > MAX_ROWS or size > MAX_BYTES:
            raise AccessRejected("Q08_SNAPSHOT_LIMIT")


def research_migration_statements(
    source: Snapshot,
    *,
    target_profile: TargetProfile = TargetProfile.LOCAL_PG17,
) -> tuple[str, ...]:
    """Owner-only extension of one sealed synthetic PG2 snapshot; caller must BEGIN.

    Exact source rows are verified on install/replay. This is not a migration of
    an active application database or a generic online upgrade mechanism.
    """
    pin = research_profile_pin(target_profile)
    schema, access = research_resources()
    _snapshot(source)
    old_pin = PG2_CATALOG_PINS[target_profile]
    from .access import _catalog_digest_sql

    before = _assert_sql(
        f"({_catalog_digest_sql()}) IN ('{old_pin}') OR ({_digest_sql()})='{pin}'",
        "Q08_PRE_CATALOG",
    )
    roles = _assert_sql(
        "(SELECT count(*) FROM pg_roles WHERE rolname IN "
        "('q08_research_read','q08_research_write') AND NOT (rolcanlogin OR rolsuper "
        "OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))=2",
        "Q08_CAPABILITY",
    )
    create = " ".join(
        "EXECUTE " + literal(stmt) + ";" for stmt in sql_statements(schema) + sql_statements(access)
    )
    ddl = (
        "DO $q08_install$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_namespace "
        "WHERE nspname='q08_research') THEN " + create + " END IF; END $q08_install$;"
    )
    parent = sha256(source.manifest()).hexdigest()
    insert = (
        "INSERT INTO q08_research.research_metadata VALUES(TRUE,'Q08_RESEARCH_STUB_V1',1,1,"
        f"'{old_pin}','{parent}','{RESEARCH_RESOURCE_SHA256}') ON CONFLICT(singleton) DO NOTHING;"
    )
    meta = _assert_sql(
        "(SELECT count(*) FROM q08_research.research_metadata)=1 AND EXISTS("
        "SELECT 1 FROM q08_research.research_metadata WHERE singleton AND schema_version=1 "
        "AND writer_version=1 AND contract='Q08_RESEARCH_STUB_V1' "
        f"AND base_catalog_sha256='{old_pin}' AND base_manifest_sha256='{parent}' "
        f"AND resource_sha256='{RESEARCH_RESOURCE_SHA256}')",
        "Q08_METADATA",
    )
    locks = (
        "LOCK TABLE " + ",".join("pg1_control." + t.name for t in source.tables) + " IN SHARE MODE;"
    )
    return tuple(
        [
            *transaction_settings(),
            "LOCK TABLE pg1_control.pg1_metadata IN SHARE MODE;",
            locks,
            before,
            metadata_sql(source),
            verification_sql(source),
            roles,
            ddl,
            insert,
            meta,
            _assert_sql(f"({_digest_sql()})='{pin}'", "Q08_POST_CATALOG"),
            verification_sql(source),
        ]
    )


def verify_research_access(
    connection: Connection[dict[str, Any]],
    *,
    writable: bool,
    target_profile: TargetProfile,
) -> None:
    pin = research_profile_pin(target_profile)
    research_resources()
    if type(writable) is not bool:
        raise AccessRejected("Q08_ACCESS_MODE")
    statements = (
        "SELECT current_user AS name,session_user AS login,rolcanlogin, "
        "rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS unsafe "
        "FROM pg_roles WHERE rolname=current_user",
        "SELECT rolname,rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR "
        "rolbypassrls OR rolcanlogin AS unsafe FROM pg_roles WHERE "
        "oid<>(SELECT oid FROM pg_roles WHERE rolname=current_user) "
        "AND pg_has_role(current_user,oid,'MEMBER')",
        "SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member "
        "WHERE r.rolname=current_user AND m.admin_option",
        "SELECT has_database_privilege(current_database(),'CREATE') "
        "OR has_database_privilege(current_database(),'TEMP') OR EXISTS(SELECT 1 FROM "
        "(VALUES ('CREATE'),('TEMP'),('CONNECT')) p(priv) WHERE "
        "has_database_privilege(current_database(),p.priv||' WITH GRANT OPTION')) "
        "OR EXISTS(SELECT 1 FROM "
        "pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema') "
        "AND n.nspname !~ '^pg_toast' AND has_schema_privilege(n.oid,'CREATE')) AS unsafe, "
        "has_schema_privilege('pg1_control','USAGE') AND "
        "has_schema_privilege('q08_research','USAGE') AS usable",
        "SELECT n.nspname,c.relname,a.attname,p.priv,has_column_privilege(c.oid,a.attnum,p.priv) "
        "AS allowed,has_column_privilege(c.oid,a.attnum,p.priv||' WITH GRANT OPTION') AS grantable "
        "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a "
        "ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped CROSS JOIN "
        "(VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(priv) "
        "WHERE n.nspname IN ('pg1_control','q08_research') AND c.relkind='r'",
        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN "
        "(VALUES ('DELETE'),('TRUNCATE'),('TRIGGER'),('MAINTAIN')) p(priv) "
        "WHERE n.nspname IN ('pg1_control','q08_research') AND c.relkind='r' "
        "AND has_table_privilege(c.oid,p.priv) LIMIT 1",
        _digest_sql(),
        "SELECT * FROM pg1_control.pg1_metadata",
        "SELECT * FROM q08_research.research_metadata",
    )
    cursor = connection.execute(";".join(statements), prepare=False)
    sets = [cursor.fetchall()]
    while cursor.nextset():
        sets.append(cursor.fetchall())
    if len(sets) != 9:
        raise AccessRejected("Q08_ACCESS_RESULTS")
    role, members, admins, ddl, cols, dangerous, digest, old_meta, meta = sets
    if (
        len(role) != 1
        or role[0]["name"] != role[0]["login"]
        or not role[0]["rolcanlogin"]
        or role[0]["unsafe"]
    ):
        raise AccessRejected("Q08_APP_LOGIN")
    cap = "q08_research_write" if writable else "q08_research_read"
    if {m["rolname"] for m in members} != {cap} or any(m["unsafe"] for m in members) or admins:
        raise AccessRejected("Q08_ROLE_MEMBERSHIP")
    if len(ddl) != 1 or ddl[0]["unsafe"] or not ddl[0]["usable"]:
        raise AccessRejected("Q08_DDL_PRIVILEGE")
    for row in cols:
        ns, table, col, priv = row["nspname"], row["relname"], row["attname"], row["priv"]
        expected = False
        if ns == "pg1_control":
            expected = priv == "SELECT" and (
                table in READ_TABLES
                or (table == "astarter_accounts" and col in {"account_id", "venue_session"})
            )
            expected |= writable and (
                (priv == "INSERT" and table in APPEND_TABLES)
                or (priv == "UPDATE" and table == "pg1_metadata" and col == "singleton")
            )
        elif ns == "q08_research":
            expected = priv == "SELECT" and table in RESEARCH_TABLES | {"research_metadata"}
            expected |= writable and (
                (priv == "INSERT" and table in RESEARCH_TABLES)
                or (priv == "UPDATE" and col in UPDATE_COLUMNS.get(table, frozenset()))
            )
        if row["allowed"] != expected or row["grantable"]:
            raise AccessRejected("Q08_COLUMN_PRIVILEGE")
    if dangerous or len(digest) != 1 or digest[0]["digest"] != pin:
        raise AccessRejected("Q08_CATALOG_MISMATCH")
    if len(meta) != 1 or len(old_meta) != 1:
        raise AccessRejected("Q08_METADATA")
    old, new = old_meta[0], meta[0]
    if (
        (
            old["schema_version"],
            old["source_version"],
            old["writer_version"],
            old["resource_sha256"],
        )
        != (1, 8, 1, CATALOG_RESOURCE_SHA256)
        or sha256(old["manifest_bytes"]).hexdigest() != old["manifest_sha256"]
        or (
            new["contract"],
            new["schema_version"],
            new["writer_version"],
            new["base_catalog_sha256"],
            new["resource_sha256"],
            new["base_manifest_sha256"],
        )
        != (
            "Q08_RESEARCH_STUB_V1",
            1,
            1,
            PG2_CATALOG_PINS[target_profile],
            RESEARCH_RESOURCE_SHA256,
            old["manifest_sha256"],
        )
    ):
        raise AccessRejected("Q08_METADATA")
