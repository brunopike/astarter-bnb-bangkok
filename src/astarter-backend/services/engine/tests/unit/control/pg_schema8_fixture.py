"""Explicit schema8 fixtures for PG tests; never a production downgrade/export API."""

import sqlite3
from hashlib import sha256
from pathlib import Path

from stark_trading_os.control import database as db
from tests.unit.control.test_astarter_strategy_migration import legacy_v6

_S03_TABLES = (
    "s03_audit", "s03_events", "s03_lifecycle", "s03_plan_manifest", "s03_signals", "s03_runs",
)
_SIDECARS = ("-wal", "-shm", "-journal")


def open_schema8_fixture(path):
    """Create a new empty fixture from frozen 001–008, with only legacy capabilities."""
    with path.open("xb"):
        pass
    connection = legacy_v6(path)
    try:
        connection.create_function("stark_control_writer_schema_version", 0, lambda: 8,
                                   deterministic=True)
        connection.create_function("stark_control_writer_schema7", 0, lambda: 7,
                                   deterministic=True)
        connection.create_function("stark_control_writer_schema8", 0, lambda: 8,
                                   deterministic=True)
        for version in (7, 8):
            connection.executescript(db._migration_sql(version))
        db._verify_exact_schema(connection, version=8)
        return connection
    except BaseException:
        connection.close()
        path.unlink()
        raise


def _added_objects():
    old = set(db._expected_schema_fingerprint(8))
    new = set(db._expected_schema_fingerprint(9))
    if not old <= new:
        raise ValueError("PG_FIXTURE_NON_ADDITIVE_SCHEMA")
    added = new - old
    tables = {row[1] for row in old if row[0] == "table"} | set(_S03_TABLES)
    expected = {("table", table) for table in _S03_TABLES}
    expected |= {("index", f"sqlite_autoindex_{table}_1") for table in _S03_TABLES}
    expected.add(("index", "sqlite_autoindex_s03_runs_2"))
    expected |= {("trigger", f"s03_{table}_{operation}")
                 for table in tables for operation in ("i", "u", "d")}
    if {(row[0], row[1]) for row in added} != expected:
        raise ValueError("PG_FIXTURE_UNKNOWN_ADDITIONS")
    return added


def legacy_rows(connection):
    """All 37 legacy tables, including sparse rowids and exact SQLite cell types."""
    result = {}
    for kind, name, _, sql in db._expected_schema_fingerprint(8):
        if kind != "table":
            continue
        info = tuple(tuple(row) for row in connection.execute(f'PRAGMA table_info("{name}")'))
        if "WITHOUT ROWID" in sql:
            selection = "*"
            order = ",".join(f'"{row[1]}"' for row in sorted(info, key=lambda row: row[5])
                             if row[5])
        else:
            selection, order = "rowid,*", "rowid"
        rows = connection.execute(f'SELECT {selection} FROM "{name}" ORDER BY {order}').fetchall()
        result[name] = info, tuple(tuple((type(cell), cell) for cell in row) for row in rows)
    return result


def derive_schema8_fixture(source, destination):
    """Copy a closed synthetic v9 fixture; remove only known empty S03 additions."""
    if source.is_symlink() or not source.is_file():
        raise ValueError("PG_FIXTURE_SOURCE_PATH")
    if any(Path(str(path) + suffix).exists()
           for path in (source, destination) for suffix in _SIDECARS):
        raise ValueError("PG_FIXTURE_NOT_DETACHED")
    before = sha256(source.read_bytes()).hexdigest()
    added = _added_objects()
    original = sqlite3.connect(source.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    original.row_factory = sqlite3.Row
    created = False
    try:
        db._verify_exact_schema(original, version=9)
        if any(original.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone()
               for table in _S03_TABLES):
            raise ValueError("PG_FIXTURE_NONEMPTY_S03")
        rows = legacy_rows(original)
        with destination.open("xb"):
            pass
        created = True
        target = sqlite3.connect(destination, isolation_level=None)
        target.row_factory = sqlite3.Row
        try:
            original.backup(target)
            target.execute("PRAGMA journal_mode=DELETE")
            target.execute("PRAGMA foreign_keys=ON")
            target.execute("BEGIN IMMEDIATE")
            for kind, name, _, _ in sorted(added):
                if kind == "trigger":
                    target.execute(f'DROP TRIGGER "{name}"')
            for table in _S03_TABLES:
                target.execute(f'DROP TABLE "{table}"')
            target.execute("PRAGMA user_version=8")
            db._verify_exact_schema(target, version=8)
            if legacy_rows(target) != rows:
                raise ValueError("PG_FIXTURE_LEGACY_ROWS_CHANGED")
            target.commit()
        finally:
            target.close()
        if sha256(source.read_bytes()).hexdigest() != before:
            raise ValueError("PG_FIXTURE_SOURCE_CHANGED")
        if any(Path(str(path) + suffix).exists()
               for path in (source, destination) for suffix in _SIDECARS):
            raise ValueError("PG_FIXTURE_NOT_DETACHED")
    except BaseException:
        if created:
            destination.unlink()
        raise
    finally:
        original.close()
    return destination
