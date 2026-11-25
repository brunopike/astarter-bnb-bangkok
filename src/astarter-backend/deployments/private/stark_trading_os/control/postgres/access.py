"""PG2 versioned access handshake, separate from the frozen PG1 verifier.

Trusted owner/cooperative DDL exclusion, not hostile DBA attestation. Scope is a
DAL boundary, not RLS: do not give backend credentials to clients.
"""
from enum import Enum
from importlib.resources import files
from typing import Any

from psycopg import Connection

from .synthetic_migration import (
    CATALOG_RESOURCE_SHA256,
    TargetProfile,
    catalog_rows_sql,
    profile_pins,
    sql_statements,
)

# Independently captured pristine PG1 + access_v1; never learn from target metadata.
PG2_CATALOG_PINS = {
    TargetProfile.LOCAL_PG17: '6fc21548cf719b55285809e43fd8bf9d6e5bea15c1d75603620f0728c4401821',
    TargetProfile.NEON_PG17_V1: '4e0b87afed98a1b8615274dbb784a78a8fd4d6bd2ca426a1ef374118df9e838a',
}
APPEND_TABLES = frozenset('astarter_' + name for name in (
    'strategy_versions', 'plan_versions', 'approval_references',
    'episode_references', 'layer_references', 'recovery_checkpoints',
))
READ_TABLES = APPEND_TABLES | {'astarter_strategy_scopes', 'pg1_metadata'}


class RepositoryAccessContract(Enum):
    PG2_REFERENCE_V1 = 'PG2_REFERENCE_V1'
    Q08_RESEARCH_STUB_V1 = 'Q08_RESEARCH_STUB_V1'
    PUBLIC_DATA_V1 = 'PUBLIC_DATA_V1'
    PRIVATE_RESEARCH_V1 = 'PRIVATE_RESEARCH_V1'


class AccessRejected(ValueError):
    """Static, sanitized access/protocol refusal."""


def access_sql() -> str:
    return files(__package__).joinpath('access_v1.sql').read_text(encoding='utf-8')


def _catalog_digest_sql() -> str:
    return (
        "SELECT encode(sha256(convert_to(coalesce(string_agg(v,E'\\n' "
        "ORDER BY v COLLATE \"C\"),''),'UTF8')),'hex') AS digest FROM ("
        + catalog_rows_sql() + ') c'
    )


def catalog_digest(connection: Connection[Any]) -> str:
    row = connection.execute(_catalog_digest_sql()).fetchone()
    assert row is not None
    return str(row['digest'] if isinstance(row, dict) else row[0])


def install_access(connection: Connection[Any], *,
                   profile: TargetProfile = TargetProfile.LOCAL_PG17) -> None:
    """Finite owner operation; create NOLOGIN capabilities separately, never app admin."""
    with connection.transaction():
        connection.execute('SET LOCAL search_path=pg_catalog')
        if type(profile) is not TargetProfile:
            raise AccessRejected('PG2_PROFILE')
        if catalog_digest(connection) not in {profile_pins(profile)[1], PG2_CATALOG_PINS[profile]}:
            raise AccessRejected('PG2_OWNER_CATALOG_MISMATCH')
        meta = connection.execute(
            'SELECT count(*) AS n FROM pg1_control.pg1_metadata WHERE singleton '
            'AND schema_version=1 AND source_version=8 AND writer_version=1 '
            'AND resource_sha256=%s AND manifest_sha256='
            "encode(sha256(manifest_bytes),'hex')", (CATALOG_RESOURCE_SHA256,),
        ).fetchone()
        if meta is None or (meta['n'] if isinstance(meta, dict) else meta[0]) != 1:
            raise AccessRejected('PG2_OWNER_METADATA')
        for role in ('pg2_reference_read', 'pg2_reference_write'):
            row = connection.execute(
                'SELECT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole '
                'OR rolreplication OR rolbypassrls AS unsafe FROM pg_roles WHERE rolname=%s',
                (role,),
            ).fetchone()
            if row is None or (row['unsafe'] if isinstance(row, dict) else row[0]):
                raise AccessRejected('PG2_CAPABILITY_ROLE')
        for statement in sql_statements(access_sql()):
            connection.execute(statement)
        if catalog_digest(connection) != PG2_CATALOG_PINS[profile]:
            raise AccessRejected('PG2_OWNER_POSTCONDITION')


def verify_access(connection: Connection[dict[str, Any]], *, writable: bool,
                  profile: TargetProfile) -> None:
    if type(profile) is not TargetProfile:
        raise AccessRejected('PG2_PROFILE')
    # Fixed read-only statements only: one wire wait, every guard still checked per transaction.
    statements = (
        'SELECT current_user AS name, session_user AS login, rolcanlogin, '
        'rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS unsafe '
        'FROM pg_roles WHERE rolname=current_user',
        "SELECT rolname, rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication "
        "OR rolbypassrls OR rolcanlogin AS unsafe FROM pg_roles "
        "WHERE oid<>(SELECT oid FROM pg_roles WHERE rolname=current_user) "
        "AND pg_has_role(current_user,oid,'MEMBER')",
        'SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member '
        'WHERE r.rolname=current_user AND m.admin_option',
        "SELECT has_database_privilege(current_database(),'CREATE') OR "
        "has_schema_privilege('pg1_control','CREATE') OR "
        "has_schema_privilege('public','CREATE') AS unsafe",
        "SELECT c.relname,a.attname,p.priv,"
        "has_column_privilege(c.oid,a.attnum,p.priv) AS allowed,"
        "has_column_privilege(c.oid,a.attnum,p.priv||' WITH GRANT OPTION') AS grantable "
        "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped "
        "CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(priv) "
        "WHERE n.nspname='pg1_control' AND c.relkind='r'",
        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "CROSS JOIN (VALUES ('DELETE'),('TRUNCATE'),('TRIGGER'),('MAINTAIN')) p(priv) "
        "WHERE n.nspname='pg1_control' AND c.relkind='r' "
        "AND has_table_privilege(c.oid,p.priv) LIMIT 1",
        _catalog_digest_sql(),
        'SELECT * FROM pg1_control.pg1_metadata',
    )
    cursor = connection.execute(';'.join(statements), prepare=False)
    results = [cursor.fetchall()]
    while cursor.nextset():
        results.append(cursor.fetchall())
    if len(results) != 8:
        raise AccessRejected('PG2_ACCESS_RESULTS')
    roles, members, admins, ddl, rows, table_privileges, digests, meta = results
    role = roles[0] if len(roles) == 1 else None
    if not role or role['name'] != role['login'] or not role['rolcanlogin'] or role['unsafe']:
        raise AccessRejected('PG2_APP_LOGIN_REQUIRED')
    cap = 'pg2_reference_write' if writable else 'pg2_reference_read'
    if {m['rolname'] for m in members} != {cap} or any(m['unsafe'] for m in members):
        raise AccessRejected('PG2_ROLE_MEMBERSHIP')
    if admins:
        raise AccessRejected('PG2_ROLE_ADMIN')
    if len(ddl) != 1 or ddl[0]['unsafe']:
        raise AccessRejected('PG2_DDL_PRIVILEGE')
    # All tables and columns, including inherited/PUBLIC permissions and grant options.
    for row in rows:
        table, column, privilege = row['relname'], row['attname'], row['priv']
        expected = (privilege == 'SELECT' and (table in READ_TABLES or (
            table == 'astarter_accounts' and column in {'account_id', 'venue_session'})))
        expected |= writable and ((privilege == 'INSERT' and table in APPEND_TABLES) or (
            privilege == 'UPDATE' and table == 'pg1_metadata' and column == 'singleton'))
        if row['allowed'] != expected or row['grantable']:
            raise AccessRejected('PG2_COLUMN_PRIVILEGE')
    if table_privileges:
        raise AccessRejected('PG2_TABLE_PRIVILEGE')
    if len(digests) != 1 or digests[0]['digest'] != PG2_CATALOG_PINS[profile]:
        raise AccessRejected('PG2_CATALOG_MISMATCH')
    if len(meta) != 1:
        raise AccessRejected('PG2_METADATA')
    from hashlib import sha256
    m = meta[0]
    if (m['schema_version'], m['source_version'], m['writer_version'], m['resource_sha256']) != (
        1, 8, 1, CATALOG_RESOURCE_SHA256
    ) or sha256(m['manifest_bytes']).hexdigest() != m['manifest_sha256']:
        raise AccessRejected('PG2_METADATA')
