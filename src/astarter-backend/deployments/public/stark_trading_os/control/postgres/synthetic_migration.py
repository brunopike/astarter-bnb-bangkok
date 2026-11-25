"""Bounded offline schema8 snapshot -> reviewed psql/MCP package. No PG connection IO.

Only explicitly supplied, closed, detached SYNTHETIC databases are supported.
Never pass an operational database. No discovery, in-place upgrade, connection
string, cloud operation, runtime transaction facade, or activation is provided.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from dataclasses import dataclass
from enum import Enum
from hashlib import sha256
from importlib import resources
from pathlib import Path
from typing import cast

from stark_trading_os.control.database import (
    _expected_schema_fingerprint,
    _schema_fingerprint,
)

type Cell = str | int | bytes | None
MAX_ROWS = 100_000
MAX_BYTES = 64 * 1024 * 1024
MARKER = "-- PG1 POST-LOAD CONSTRAINTS AND GUARDS"

# PG17 catalog oracle captured from the pristine resource, NOT from target metadata.
# Changing the resource requires independent PG regeneration and review of this pin.
CATALOG_RESOURCE_SHA256 = "5c3100a28b6f257e9523bef65e50c2b34ce52479a45f223daf330fef028aba75"
CATALOG_SHA256 = "9b41f9b962765e81ec3c82098085298b1b59cb4daebf7d3a1058c72536a69b00"
EMPTY_CATALOG_SHA256 = "9161b39451561c9fa53fa31ca8ae96ecd87aee0615888409fe6d03781fbd1edd"


class TargetProfile(Enum):
    LOCAL_PG17 = "LOCAL_PG17"
    NEON_PG17_V1 = "NEON_PG17_V1"


def profile_pins(profile: TargetProfile) -> tuple[str, str]:
    """Fixed reviewed empty/full pins, never learned from a target or metadata."""
    if type(profile) is not TargetProfile:
        raise MigrationRejected("PG1_TARGET_PROFILE")
    if profile is TargetProfile.LOCAL_PG17:
        return EMPTY_CATALOG_SHA256, CATALOG_SHA256
    return ("8d1aa29bb227946de88601bd5545a1d463830d85fe6e04b14c133d37697f1d94",
            "56bfbb75089116a5e8aadbd88d5d9c407ee577e1eb6bdc415317dd70147160f2")


def catalog_rows_sql() -> str:
    """OID/owner-independent PG17 semantics. Run with search_path=pg_catalog.

    Namespace dependency inventory also detects extra domains, operators, views,
    sequences and other schema objects, not merely tables. Owner remains trusted;
    this is drift detection under cooperative DDL exclusion, not DBA attestation.
    Column ACLs include every explicit grant, including owner entries. Tagged
    owner/public/role identities avoid OID and owner-name dependence without
    conflating named roles; grantor, privilege and grant option remain semantic.
    Default ACL headers retain even empty objects and namespace=0 global defaults.
    Their creator/grantor/grantee names are literal identities, NOT generic owners.
    """
    return """WITH ns AS (
 SELECT oid,nspname FROM pg_namespace
 WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_toast'
), rel AS (SELECT c.* FROM pg_class c JOIN ns ON ns.oid=c.relnamespace),
rows(v) AS (
 SELECT json_build_array('namespace',nspname)::text FROM ns
 UNION ALL SELECT json_build_array('object',i.type,i.schema,i.name,i.identity)::text
 FROM pg_depend d JOIN ns ON d.refobjid=ns.oid AND d.refclassid='pg_namespace'::regclass
 CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) i
 UNION ALL SELECT json_build_array('relation',c.oid::regclass::text,c.relkind,
 c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relreplident,c.reloptions)::text
 FROM rel c
 UNION ALL SELECT json_build_array('column',c.oid::regclass::text,a.attnum,a.attname,
 format_type(a.atttypid,a.atttypmod),a.attnotnull,co.collname,cn.nspname,
 pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated,a.attisdropped)::text
 FROM rel c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 LEFT JOIN pg_collation co ON co.oid=a.attcollation
 LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
 UNION ALL SELECT json_build_array('constraint',c.conrelid::regclass::text,c.conname,
 c.contype,c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid,false))::text
 FROM pg_constraint c JOIN ns ON ns.oid=c.connamespace
 UNION ALL SELECT json_build_array('index',c.oid::regclass::text,pg_get_indexdef(c.oid),
 i.indisvalid,i.indisready,i.indislive,i.indisreplident)::text
 FROM rel c JOIN pg_index i ON i.indexrelid=c.oid
 UNION ALL SELECT json_build_array('trigger',c.oid::regclass::text,
 CASE WHEN t.tgisinternal THEN k.conname ELSE t.tgname END,t.tgisinternal,
 t.tgenabled,t.tgtype,t.tgfoid::regprocedure::text,t.tgdeferrable,t.tginitdeferred,
 CASE WHEN NOT t.tgisinternal THEN pg_get_triggerdef(t.oid,false) END)::text
 FROM rel c JOIN pg_trigger t ON t.tgrelid=c.oid
 LEFT JOIN pg_constraint k ON k.oid=t.tgconstraint
 UNION ALL SELECT json_build_array('function',p.oid::regprocedure::text,
 pg_get_functiondef(p.oid))::text FROM pg_proc p JOIN ns ON ns.oid=p.pronamespace
 UNION ALL SELECT json_build_array('rule',c.oid::regclass::text,r.rulename,
 pg_get_ruledef(r.oid,false))::text FROM rel c JOIN pg_rewrite r ON r.ev_class=c.oid
 UNION ALL SELECT json_build_array('policy',c.oid::regclass::text,p.polname,
 p.polcmd,p.polpermissive,pg_get_expr(p.polqual,p.polrelid),
 pg_get_expr(p.polwithcheck,p.polrelid))::text FROM rel c JOIN pg_policy p ON p.polrelid=c.oid
 UNION ALL SELECT json_build_array('extension',extname,extversion)::text
 FROM pg_extension WHERE extname<>'plpgsql'
 UNION ALL SELECT json_build_array('event_trigger',evtname,evtevent,evtenabled)::text
 FROM pg_event_trigger
 UNION ALL SELECT json_build_array('grant',c.oid::regclass::text,
 a.grantee::regrole::text,a.privilege_type,a.is_grantable)::text
 FROM rel c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE a.grantee<>c.relowner
 UNION ALL SELECT json_build_array('column_grant',c.oid::regclass::text,
 col.attnum,col.attname,
 CASE WHEN a.grantor=c.relowner THEN json_build_array('owner')
 ELSE json_build_array('role',a.grantor::regrole::text) END,
 CASE WHEN a.grantee=0 THEN json_build_array('public')
 WHEN a.grantee=c.relowner THEN json_build_array('owner')
 ELSE json_build_array('role',a.grantee::regrole::text) END,
 a.privilege_type,a.is_grantable)::text
 FROM rel c JOIN pg_attribute col ON col.attrelid=c.oid AND col.attnum>0
 CROSS JOIN LATERAL aclexplode(col.attacl) a
 UNION ALL SELECT json_build_array('function_grant',p.oid::regprocedure::text,
 a.grantee::regrole::text,a.privilege_type,a.is_grantable)::text
 FROM pg_proc p JOIN ns ON ns.oid=p.pronamespace
 CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE a.grantee<>p.proowner
 UNION ALL SELECT json_build_array('schema_grant',n.nspname,a.grantee::regrole::text,
 a.privilege_type,a.is_grantable)::text FROM pg_namespace n
 CROSS JOIN LATERAL aclexplode(n.nspacl) a
 WHERE n.nspname='pg1_control' AND a.grantee<>n.nspowner
 UNION ALL SELECT json_build_array('default_acl',d.defaclrole::regrole::text,
 CASE WHEN d.defaclnamespace=0 THEN json_build_array('global')
 ELSE json_build_array('schema',n.nspname) END,d.defaclobjtype)::text
 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
 UNION ALL SELECT json_build_array('default_acl_grant',d.defaclrole::regrole::text,
 CASE WHEN d.defaclnamespace=0 THEN json_build_array('global')
 ELSE json_build_array('schema',n.nspname) END,d.defaclobjtype,
 a.grantor::regrole::text,
 CASE WHEN a.grantee=0 THEN json_build_array('public')
 ELSE json_build_array('role',a.grantee::regrole::text) END,
 a.privilege_type,a.is_grantable)::text
 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
 CROSS JOIN LATERAL aclexplode(d.defaclacl) a
) SELECT v FROM rows"""


def catalog_check_sql(*, empty: bool = False,
                      profile: TargetProfile = TargetProfile.LOCAL_PG17) -> str:
    empty_pin, full_pin = profile_pins(profile)
    expected = empty_pin if empty else full_pin
    category = "PG1_TARGET_NOT_EMPTY" if empty else "PG1_CATALOG_MISMATCH"
    return ("DO $pg1_catalog$ BEGIN IF (SELECT encode(sha256(convert_to("
            "coalesce(string_agg(v,E'\\n' ORDER BY v COLLATE \"C\"),''),'UTF8')),'hex') FROM ("
            + catalog_rows_sql() + ") c) IS DISTINCT FROM '" + expected + "' THEN "
            "RAISE EXCEPTION USING MESSAGE='" + category + "'; END IF; END $pg1_catalog$;")


def sql_statements(sql: str) -> list[str]:
    """Split only this fixed resource grammar; quoted/dollar bodies remain atomic.

    Not a general SQL parser or driver. The resource uses standard strings,
    identifiers, line comments and dollar bodies, not E-strings or block comments.
    Reject unsupported/unclosed grammar rather than guessing for MCP.
    """
    token = re.compile(r"--[^\n]*(?:\n|$)|'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"|"
                       r"\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$")
    result: list[str] = []
    start = pos = 0
    while pos < len(sql):
        match = token.match(sql, pos)
        if match:
            word = match.group()
            pos = match.end()
            if word.startswith('$'):
                end = sql.find(word, pos)
                if end < 0:
                    raise MigrationRejected("PG1_SQL_BOUNDARY")
                pos = end + len(word)
        elif sql[pos] == ';':
            result.append(sql[start:pos + 1].strip())
            pos += 1
            start = pos
        elif sql[pos] in "'\"$\\" or sql.startswith('/*', pos):
            raise MigrationRejected("PG1_SQL_BOUNDARY")
        else:
            pos += 1
    if sql[start:].strip():
        raise MigrationRejected("PG1_SQL_BOUNDARY")
    return result


class MigrationRejected(ValueError):
    """Fixed public error categories; never includes input values or SQL."""


@dataclass(frozen=True)
class Table:
    name: str
    columns: tuple[tuple[str, str], ...]
    ordering: tuple[str, ...]
    rows: tuple[tuple[Cell, ...], ...]

    @property
    def row_hashes(self) -> tuple[str, ...]:
        return tuple(sha256(b"".join(frame(c) for c in r)).hexdigest() for r in self.rows)


@dataclass(frozen=True)
class Snapshot:
    tables: tuple[Table, ...]
    source_sha256: str

    def manifest(self) -> bytes:
        return json.dumps(
            {"format": "PG1_TYPED_V1", "source_schema": 8, "target_schema": 1,
             "schema_sha256": sha256(schema_sql().encode()).hexdigest(),
             "source_schema_sha256": sha256(json.dumps(
                 _expected_schema_fingerprint(8), separators=(",", ":")).encode()).hexdigest(),
             "tables": [{"name": t.name, "columns": t.columns, "ordering": t.ordering,
                         "row_hashes": t.row_hashes,
                         "table_sha256": sha256("".join(t.row_hashes).encode()).hexdigest()}
                        for t in self.tables]},
            sort_keys=True, separators=(",", ":"), ensure_ascii=True,
        ).encode()


def frame(value: Cell) -> bytes:
    """Unambiguous type + byte-length + raw bytes; no JSON re-encoding of payloads."""
    if value is None:
        return b"n0:"
    if type(value) is int:
        if not -(2**63) <= value < 2**63:
            raise MigrationRejected("PG1_INTEGER_RANGE")
        payload, tag = str(value).encode(), b"i"
    elif type(value) is str:
        if "\x00" in value:
            raise MigrationRejected("PG1_TEXT_NUL")
        try:
            payload = value.encode("utf-8", errors="strict")
        except UnicodeError:
            raise MigrationRejected("PG1_TEXT_ENCODING") from None
        tag = b"t"
    elif type(value) is bytes:
        payload, tag = value, b"b"
    else:
        raise MigrationRejected("PG1_CELL_TYPE")
    return tag + str(len(payload)).encode() + b":" + payload


def schema_sql() -> str:
    return resources.files(__package__).joinpath("schema_v1.sql").read_text(encoding="utf-8")


def snapshot(path: Path) -> Snapshot:
    """Read one CLOSED synthetic file without journal/SHM creation or source writes.

    immutable=1 is safe only for this deliberately detached fixture contract.
    It is NOT a live SQLite backup strategy. Active WAL and symlinks are refused.
    A before/after digest detects modification; no live-source guarantee is claimed.
    """
    if path.is_symlink() or not path.is_file():
        raise MigrationRejected("PG1_SOURCE_PATH")
    if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise MigrationRejected("PG1_SOURCE_NOT_DETACHED")
    if path.stat().st_size > MAX_BYTES:
        raise MigrationRejected("PG1_SOURCE_LIMIT")
    before = sha256(path.read_bytes()).hexdigest()
    try:
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    except sqlite3.Error:
        raise MigrationRejected("PG1_SOURCE_OPEN") from None
    try:
        connection.execute("BEGIN")
        if connection.execute("PRAGMA user_version").fetchone()[0] != 8:
            raise MigrationRejected("PG1_SOURCE_VERSION")
        if _schema_fingerprint(connection) != _expected_schema_fingerprint(8):
            raise MigrationRejected("PG1_SOURCE_SCHEMA")
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise MigrationRejected("PG1_SOURCE_FK")
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise MigrationRejected("PG1_SOURCE_INTEGRITY")
        tables: list[Table] = []
        total = 0
        size = 0
        for name, definition in connection.execute(
            "SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name"
        ).fetchall():
            info = connection.execute(f'PRAGMA table_info("{name}")').fetchall()
            cols = tuple((str(r[1]), str(r[2])) for r in info)
            has_rowid = "WITHOUT ROWID" not in definition
            ordering: tuple[str, ...]
            if has_rowid:
                cols = (("legacy_rowid", "INTEGER"),) + cols
                selection, ordering = "rowid,*", ("legacy_rowid",)
                order_sql = "rowid"
            else:
                selection = "*"
                ordering = tuple(str(r[1]) for r in sorted(info, key=lambda r: r[5]) if r[5])
                order_sql = ",".join('"' + n + '"' for n in ordering)
            rows = connection.execute(
                f'SELECT {selection} FROM "{name}" ORDER BY {order_sql}'
            ).fetchmany(MAX_ROWS + 1)
            total += len(rows)
            if total > MAX_ROWS:
                raise MigrationRejected("PG1_ROW_LIMIT")
            for row in rows:
                for (_, kind), cell in zip(cols, row, strict=True):
                    if cell is not None and type(cell) is not {
                        "TEXT": str, "INTEGER": int, "BLOB": bytes,
                    }[kind]:
                        raise MigrationRejected("PG1_CELL_TYPE")
                    size += len(frame(cast(Cell, cell)))
                    if size > MAX_BYTES:
                        raise MigrationRejected("PG1_DATA_LIMIT")
            tables.append(Table(name, cols, ordering, tuple(tuple(r) for r in rows)))
        connection.rollback()
    except (sqlite3.Error, UnicodeError):
        raise MigrationRejected("PG1_SOURCE_INVALID") from None
    finally:
        connection.close()
    if sha256(path.read_bytes()).hexdigest() != before:
        raise MigrationRejected("PG1_SOURCE_CHANGED")
    if len(tables) != 37:
        raise MigrationRejected("PG1_TABLE_SET")
    return Snapshot(tuple(tables), before)


def literal(value: Cell) -> str:
    frame(value)
    if value is None:
        return "NULL"
    if type(value) is int:
        return str(value)
    if type(value) is bytes:
        return "decode('" + value.hex() + "','hex')"
    return "convert_from(decode('" + cast(str, value).encode().hex() + "','hex'),'UTF8')"


def _hash_expression(table: Table) -> str:
    cells = []
    for name, kind in table.columns:
        col = '"' + name + '"'
        raw = col if kind == "BLOB" else f"convert_to({col}::text,'UTF8')"
        tag = {"TEXT": "t", "INTEGER": "i", "BLOB": "b"}[kind]
        cells.append(
            f"CASE WHEN {col} IS NULL THEN convert_to('n0:','UTF8') ELSE "
            f"convert_to('{tag}'||octet_length({raw})::text||':','UTF8')||{raw} END"
        )
    return "encode(sha256(" + "||".join(cells) + "),'hex')"


def verification_sql(source: Snapshot, *,
                     profile: TargetProfile = TargetProfile.LOCAL_PG17) -> str:
    """Typed-only check; replay/export also requires the selected catalog check."""
    profile_pins(profile)
    checks = []
    for table in source.tables:
        expected = "ARRAY[" + ",".join("'" + h + "'" for h in table.row_hashes) + "]::text[]"
        order = ",".join('"' + n + '"' for n in table.ordering)
        checks.append(
            f"IF (SELECT coalesce(array_agg(h ORDER BY {order}),ARRAY[]::text[]) "
            f"FROM (SELECT *, {_hash_expression(table)} AS h "
            f"FROM pg1_control.{table.name}) AS typed) IS DISTINCT FROM {expected} THEN "
            "RAISE EXCEPTION USING MESSAGE='PG1_TYPED_MISMATCH'; END IF;"
        )
    return "DO $pg1_verify$ BEGIN\n" + "\n".join(checks) + "\nEND $pg1_verify$;\n"


def import_statements(source: Snapshot) -> list[str]:
    """One statement per row, shared byte-for-byte by psql and MCP export."""
    data = []
    for table in source.tables:
        names = ",".join('"' + n + '"' for n, _ in table.columns)
        for row in table.rows:
            data.append(f"INSERT INTO pg1_control.{table.name} ({names}) VALUES ("
                        + ",".join(literal(cell) for cell in row) + ");")
    return data


def metadata_sql(source: Snapshot, *, insert: bool = False) -> str:
    manifest = source.manifest()
    digest = sha256(manifest).hexdigest()
    resource_hash = sha256(schema_sql().encode()).hexdigest()
    if resource_hash != CATALOG_RESOURCE_SHA256:
        raise MigrationRejected("PG1_RESOURCE_CATALOG_PIN")
    if insert:
        return ("INSERT INTO pg1_control.pg1_metadata VALUES "
                f"(TRUE,1,8,1,'{resource_hash}','{digest}',{literal(manifest)});")
    return f"""DO $pg1$ BEGIN
 IF (SELECT count(*) FROM pg1_control.pg1_metadata)<>1 OR NOT EXISTS(
 SELECT 1 FROM pg1_control.pg1_metadata WHERE singleton
 AND schema_version=1 AND source_version=8 AND writer_version=1
 AND resource_sha256='{resource_hash}' AND manifest_sha256='{digest}'
 AND manifest_bytes={literal(manifest)}) THEN
 RAISE EXCEPTION USING MESSAGE='PG1_MANIFEST_OR_VERSION_MISMATCH'; END IF;
END $pg1$;"""


def transaction_settings() -> list[str]:
    return ["SET LOCAL statement_timeout='30s';", "SET LOCAL lock_timeout='5s';",
            "SET LOCAL search_path=pg_catalog;", "SET LOCAL standard_conforming_strings=on;",
            "SELECT pg_advisory_xact_lock(170501,1);"]


def new_target_statements(source: Snapshot, *,
                          profile: TargetProfile = TargetProfile.LOCAL_PG17) -> list[str]:
    profile_pins(profile)
    before, after = schema_sql().split(MARKER)
    return ([catalog_check_sql(empty=True, profile=profile)] + sql_statements(before)
            + import_statements(source) + sql_statements(after)
            + [metadata_sql(source, insert=True), "SET LOCAL search_path=pg_catalog;",
               catalog_check_sql(profile=profile), verification_sql(source, profile=profile)])


def replay_statements(source: Snapshot, *,
                      profile: TargetProfile = TargetProfile.LOCAL_PG17) -> list[str]:
    profile_pins(profile)
    locks = ",".join("pg1_control." + t.name for t in source.tables)
    return ["LOCK TABLE pg1_control.pg1_metadata IN SHARE MODE;",
            f"LOCK TABLE {locks} IN SHARE MODE;", metadata_sql(source),
            catalog_check_sql(profile=profile), verification_sql(source, profile=profile)]


def cloud_smoke_plan(source: Snapshot, *,
                     profile: TargetProfile = TargetProfile.LOCAL_PG17) -> dict[str, object]:
    """Structured review artifact, not a cloud client. Root supplies atomic execution."""
    empty_pin, full_pin = profile_pins(profile)
    before, after = schema_sql().split(MARKER)
    return {
        "format": "PG1_NEON_SMOKE_V1", "execution_authorized": False,
        "synthetic_only": True,
        "target": ("NEW_EXCLUSIVE_EMPTY_CHILD_OF_EXISTING_NEON_SANDBOX"
                   if profile is TargetProfile.NEON_PG17_V1 else "NEW_EXCLUSIVE_EMPTY_LOCAL_PG17"),
        "source_sha256": source.source_sha256,
        "manifest_sha256": sha256(source.manifest()).hexdigest(),
        "resource_sha256": sha256(schema_sql().encode()).hexdigest(),
        "target_profile": profile.value,
        "empty_catalog_sha256": empty_pin,
        "catalog_sha256": full_pin,
        "requires_single_transaction": True,
        "transaction_statements": transaction_settings()
        + new_target_statements(source, profile=profile),
        "schema_statements": sql_statements(before),
        "import_statements": import_statements(source),
        "post_load_schema_statements": sql_statements(after),
        "reopen_transaction_statements": transaction_settings()
        + replay_statements(source, profile=profile),
        "instructions": [
            "Review first; execute transaction_statements in ONE transaction; abort on error.",
            "schema_statements/import_statements are review views, never separate transactions.",
            "NEON_PG17_V1: existing sandbox/new child only; no new project or quota increase.",
            "No target repair, baseline relaxation, cleanup or existing database adoption.",
            "If Neon baseline differs, stop and inspect it; do not modify the empty-target gate.",
            "Reopen with a new connection; execute reopen_transaction_statements atomically.",
            "Local SQL proof is not Neon direct/pooled/app-driver/auth validation.",
        ],
    }


def bundle_sql(source: Snapshot, *,
               profile: TargetProfile = TargetProfile.LOCAL_PG17) -> str:
    """psql wrapper over the SAME independently executable cloud statement lists.

    The fixed advisory lock is also the cooperative owner DDL exclusion protocol.
    Tables are SHARE locked through catalog + metadata + typed verification.
    No writes or schema repairs occur on the existing-target path.
    """
    profile_pins(profile)
    settings = "\n".join(transaction_settings())
    replay = "\n".join(replay_statements(source, profile=profile))
    new = "\n".join(new_target_statements(source, profile=profile))
    return f"""-- SYNTHETIC ONLY / PG1 / execution_authorized=false / NOT runtime cutover.
-- target_profile={profile.value}
\\set ON_ERROR_STOP on
BEGIN;
{settings}
SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='pg1_control') AS pg1_exists \\gset
\\if :pg1_exists
{replay}
\\else
{new}
\\endif
COMMIT;
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--closed-synthetic-source", type=Path, required=True)
    parser.add_argument("--new-output-directory", type=Path, required=True)
    parser.add_argument("--target-profile", choices=[p.value for p in TargetProfile],
                        default=TargetProfile.LOCAL_PG17.value)
    args = parser.parse_args()
    try:
        profile = TargetProfile(args.target_profile)
        profile_pins(profile)
        source = snapshot(args.closed_synthetic_source)
        sql = bundle_sql(source, profile=profile)
        output: Path = args.new_output_directory
        output.mkdir(mode=0o700, parents=False, exist_ok=False)
        (output / "manifest.json").write_bytes(source.manifest())
        (output / "bundle.sql").write_text(sql, encoding="utf-8")
        (output / "neon-smoke-plan.json").write_text(
            json.dumps(cloud_smoke_plan(source, profile=profile), indent=2), encoding="utf-8")
        (output / "verify.sql").write_text(
            "BEGIN;\n" + "\n".join(transaction_settings()
                                    + replay_statements(source, profile=profile))
            + "\nCOMMIT;\n", encoding="utf-8",
        )
    except MigrationRejected as error:
        print(str(error))
        return 2
    except (OSError, ValueError):
        print("PG1_PACKAGE_IO")
        return 2
    print("PG1_PACKAGE_WRITTEN_NOT_EXECUTED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
