"""SQLite connection and migration authority for the local control registry."""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from functools import cache
from importlib import resources
from pathlib import Path
from time import sleep

_BUSY_TIMEOUT_MS = 5_000
_BOOTSTRAP_ATTEMPTS = 8
_BOOTSTRAP_RETRY_DELAY_SECONDS = 0.01
_MIGRATION_RESOURCES = (
    ("control", "migrations", "001_control.sql"),
    ("control", "migrations", "002_terminal_preparations.sql"),
    ("control", "migrations", "003_strategy_configurations.sql"),
    ("control", "migrations", "004_historical_configuration_kinds.sql"),
    ("control", "migrations", "005_historical_control_chain.sql"),
    ("control", "migrations", "006_astarter_simulation.sql"),
    ("control", "migrations", "007_astarter_strategy_persistence.sql"),
    ("control", "migrations", "008_astarter_atomic_control.sql"),
    ("control", "migrations", "009_s03_bridge.sql"),
)
_SCHEMA_VERSION = 9
_BOOTSTRAP_LOCK = threading.Lock()
type _SchemaFingerprint = tuple[tuple[str, str, str, str | None], ...]


class DatabaseConfigurationError(RuntimeError):
    """Raised when SQLite cannot provide the required durability configuration."""


def open_control_database(path: str | Path) -> sqlite3.Connection:
    """Open, configure, verify, and migrate one independent SQLite connection."""

    database_path = Path(path)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(
        database_path,
        isolation_level=None,
        timeout=_BUSY_TIMEOUT_MS / 1_000,
    )
    connection.row_factory = sqlite3.Row
    try:
        # Exact-version SQL guards reject even an already-open older binary, which
        # cannot run our Python checks after another process migrates its DB.
        writer_schema_version = _SCHEMA_VERSION
        connection.create_function(
            "stark_control_writer_schema_version",
            0,
            lambda: writer_schema_version,
            deterministic=True,
        )
        # A new capability name fences even zero-row statements at preparation.
        connection.create_function(
            "stark_control_writer_schema7", 0, lambda: 7,
            deterministic=True,
        )
        connection.create_function(
            "stark_control_writer_schema8", 0, lambda: 8,
            deterministic=True,
        )
        connection.create_function(
            "stark_control_writer_schema9", 0, lambda: writer_schema_version,
            deterministic=True,
        )
        with _BOOTSTRAP_LOCK:
            connection.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
            _bootstrap_with_retry(connection)
    except BaseException:
        connection.close()
        raise
    return connection


def _bootstrap_with_retry(connection: sqlite3.Connection) -> None:
    for attempt in range(_BOOTSTRAP_ATTEMPTS):
        try:
            _bootstrap_once(connection)
        except sqlite3.OperationalError as error:
            if not _is_retryable_lock(error) or attempt + 1 == _BOOTSTRAP_ATTEMPTS:
                raise
            if connection.in_transaction:
                connection.rollback()
            sleep(min(_BOOTSTRAP_RETRY_DELAY_SECONDS * (2**attempt), 0.1))
        else:
            return
    raise RuntimeError("Unreachable SQLite bootstrap retry state.")


def _bootstrap_once(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA foreign_keys = ON")
    journal_mode = connection.execute("PRAGMA journal_mode = WAL").fetchone()
    connection.execute("PRAGMA synchronous = FULL")
    _verify_connection(connection, journal_mode=journal_mode)
    existing_version = _pragma_integer(connection, "user_version")
    if existing_version > _SCHEMA_VERSION:
        raise DatabaseConfigurationError(
            f"Control database schema {existing_version} is newer than supported "
            f"version {_SCHEMA_VERSION}."
        )
    if existing_version == 0:
        existing_version = _initialize_empty_v1(connection)
    if existing_version == 1:
        existing_version = _preflight_v1(connection)
        if existing_version == 1:
            _upgrade_v1_to_v2(connection)
            existing_version = _pragma_integer(connection, "user_version")
    if existing_version == 2:
        existing_version = _preflight_v2(connection)
        if existing_version == 2:
            _upgrade_v2_to_v3(connection)
            existing_version = _pragma_integer(connection, "user_version")
    if existing_version == 3:
        _upgrade_v3_to_v4(connection)
        existing_version = _pragma_integer(connection, "user_version")
    if existing_version == 4:
        _upgrade_v4_to_v5(connection)
        existing_version = _pragma_integer(connection, "user_version")
    if existing_version == 5:
        _upgrade_v5_to_v6(connection)
        existing_version = _pragma_integer(connection, "user_version")
    if existing_version == 6:
        _upgrade_v6_to_v7(connection)
        existing_version = _pragma_integer(connection, "user_version")
    if existing_version == 7:
        _upgrade_v7_to_v8(connection)
        existing_version = _pragma_integer(connection, "user_version")
    if existing_version == 8:
        _upgrade_v8_to_v9(connection)
        existing_version = _pragma_integer(connection, "user_version")
    if existing_version != 9:
        raise DatabaseConfigurationError(
            f"Unsupported control database version: {existing_version}."
        )
    _verify_exact_schema(connection, version=9)


def _is_retryable_lock(error: sqlite3.OperationalError) -> bool:
    error_code = getattr(error, "sqlite_errorcode", None)
    if type(error_code) is not int:
        return False
    base_code = error_code & 0xFF
    return base_code in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}


def verify_control_connection(connection: sqlite3.Connection) -> None:
    """Reject a connection that bypassed the control database factory."""

    _verify_write_connection(connection)
    _verify_exact_schema(connection, version=_SCHEMA_VERSION)


def _verify_exact_schema(connection: sqlite3.Connection, *, version: int) -> None:
    if _pragma_integer(connection, "user_version") != version:
        raise DatabaseConfigurationError(f"Unsupported control database version: {version}.")
    actual_schema = _schema_fingerprint(connection)
    if actual_schema != _expected_schema_fingerprint(version):
        raise DatabaseConfigurationError("Control database schema fingerprint is invalid.")
    foreign_key_violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    if foreign_key_violations:
        raise DatabaseConfigurationError("Control database contains foreign key violations.")
    integrity_rows = connection.execute("PRAGMA integrity_check").fetchall()
    if len(integrity_rows) != 1 or str(integrity_rows[0][0]).lower() != "ok":
        raise DatabaseConfigurationError("Control database integrity check failed.")


def _verify_write_connection(connection: sqlite3.Connection) -> None:
    """Perform the lightweight configuration gate required before every write."""

    journal_mode = connection.execute("PRAGMA journal_mode").fetchone()
    _verify_connection(connection, journal_mode=journal_mode)
    _verify_user_version(connection)


@contextmanager
def _immediate_transaction(connection: sqlite3.Connection) -> Iterator[None]:
    """Run one explicit single-writer transaction and roll back every failed write."""

    _verify_write_connection(connection)
    if connection.in_transaction:
        raise RuntimeError("Nested control database transactions are not permitted.")
    try:
        connection.execute("BEGIN IMMEDIATE")
        # A different process may migrate after the optimistic check above.
        _verify_write_connection(connection)
        yield
    except BaseException:
        connection.rollback()
        raise
    else:
        try:
            connection.commit()
        except BaseException:
            connection.rollback()
            raise


def _migration_sql(version: int) -> str:
    if version not in {1, 2, 3, 4, 5, 6, 7, 8, 9}:
        raise ValueError(f"Unsupported migration resource version: {version}.")
    resource = resources.files("stark_trading_os")
    for component in _MIGRATION_RESOURCES[version - 1]:
        resource = resource.joinpath(component)
    return resource.read_text(encoding="utf-8")


@cache
def _expected_schema_fingerprint(version: int) -> _SchemaFingerprint:
    if version not in {1, 2, 3, 4, 5, 6, 7, 8, 9}:
        raise ValueError(f"Unsupported schema fingerprint version: {version}.")
    reference = sqlite3.connect(":memory:", isolation_level=None)
    reference.row_factory = sqlite3.Row
    try:
        reference.execute("PRAGMA foreign_keys = ON")
        for migration_version in range(1, version + 1):
            reference.executescript(_migration_sql(migration_version))
        return _schema_fingerprint(reference)
    finally:
        reference.close()


def _schema_fingerprint(connection: sqlite3.Connection) -> _SchemaFingerprint:
    rows = connection.execute(
        """
        SELECT type, name, tbl_name, sql
        FROM sqlite_schema
        ORDER BY type, name
        """
    ).fetchall()
    fingerprint: list[tuple[str, str, str, str | None]] = []
    for row in rows:
        object_type = row[0]
        name = row[1]
        table_name = row[2]
        sql = row[3]
        if type(object_type) is not str or type(name) is not str or type(table_name) is not str:
            raise DatabaseConfigurationError("SQLite schema metadata is malformed.")
        if sql is not None and type(sql) is not str:
            raise DatabaseConfigurationError("SQLite schema SQL is malformed.")
        fingerprint.append((object_type, name, table_name, sql))
    return tuple(fingerprint)


def _verify_connection(
    connection: sqlite3.Connection,
    *,
    journal_mode: sqlite3.Row | tuple[object, ...] | None,
) -> None:
    mode = None if journal_mode is None else str(journal_mode[0]).lower()
    if mode != "wal":
        raise DatabaseConfigurationError(f"SQLite journal_mode must be WAL, received {mode!r}.")
    if _pragma_integer(connection, "foreign_keys") != 1:
        raise DatabaseConfigurationError("SQLite foreign_keys must be enabled.")
    if _pragma_integer(connection, "busy_timeout") < _BUSY_TIMEOUT_MS:
        raise DatabaseConfigurationError(
            f"SQLite busy_timeout must be at least {_BUSY_TIMEOUT_MS}ms."
        )
    if _pragma_integer(connection, "synchronous") != 2:
        raise DatabaseConfigurationError("SQLite synchronous mode must be FULL.")
    if _pragma_integer(connection, "writable_schema") != 0:
        raise DatabaseConfigurationError("SQLite writable_schema must be disabled.")
    if _pragma_integer(connection, "ignore_check_constraints") != 0:
        raise DatabaseConfigurationError("SQLite CHECK constraints must be enabled.")
    if connection.isolation_level is not None:
        raise DatabaseConfigurationError("SQLite isolation_level must be None.")
    if connection.row_factory is not sqlite3.Row:
        raise DatabaseConfigurationError("SQLite row_factory must be sqlite3.Row.")


def _verify_user_version(connection: sqlite3.Connection) -> None:
    version = _pragma_integer(connection, "user_version")
    if version != _SCHEMA_VERSION:
        raise DatabaseConfigurationError(f"Unsupported control database version: {version}.")


def _reject_legacy_terminal_residue(connection: sqlite3.Connection) -> None:
    row = connection.execute(
        """
        SELECT
            EXISTS (
                SELECT 1 FROM runs
                WHERE prepared_terminal_state IS NOT NULL
                   OR prepared_terminal_state_version IS NOT NULL
                   OR prepared_terminal_event_seq IS NOT NULL
            )
            OR EXISTS (
                SELECT 1 FROM events
                WHERE type IN ('run.completed', 'run.failed', 'run.cancelled')
            )
            OR EXISTS (SELECT 1 FROM seals)
            OR EXISTS (SELECT 1 FROM finalization_faults)
        """
    ).fetchone()
    if row is None or type(row[0]) is not int:
        raise DatabaseConfigurationError("Legacy terminal-residue query is malformed.")
    if row[0] != 0:
        raise DatabaseConfigurationError(
            "Refusing to upgrade a v1 database with legacy terminal residue."
        )


def _migration_statements(version: int) -> tuple[str, ...]:
    statements: list[str] = []
    buffer = ""
    for line in _migration_sql(version).splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            statement = buffer.strip()
            if statement:
                statements.append(statement)
            buffer = ""
    if buffer.strip():
        raise DatabaseConfigurationError("Migration contains an incomplete SQL statement.")
    if (
        len(statements) < 3
        or statements[0].rstrip(";").strip().upper() != "BEGIN IMMEDIATE"
        or statements[-1].rstrip(";").strip().upper() != "COMMIT"
    ):
        raise DatabaseConfigurationError("Migration transaction boundary is invalid.")
    normalized = tuple(statement.rstrip(";").strip().upper() for statement in statements)
    forbidden_controls = ("BEGIN", "COMMIT", "END TRANSACTION", "ROLLBACK")
    if any(
        statement.startswith(forbidden_controls)
        for statement in normalized[1:-1]
    ):
        raise DatabaseConfigurationError("Migration contains an unexpected transaction control.")
    expected_version = f"PRAGMA USER_VERSION = {version}"
    if sum(statement == expected_version for statement in normalized) != 1:
        raise DatabaseConfigurationError("Migration user_version statement is invalid.")
    return tuple(statements)


def _preflight_v1(connection: sqlite3.Connection) -> int:
    try:
        connection.execute("BEGIN")
        snapshot_version = _pragma_integer(connection, "user_version")
        if snapshot_version in {2, 3, 4, 5, 6, 7, 8, 9}:
            connection.commit()
            return snapshot_version
        if snapshot_version != 1:
            raise DatabaseConfigurationError(
                f"Control database version changed during v1 preflight: {snapshot_version}."
            )
        _verify_exact_schema(connection, version=1)
        _reject_legacy_terminal_residue(connection)
        connection.commit()
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    return 1


def _upgrade_v1_to_v2(connection: sqlite3.Connection) -> bool:
    statements = _migration_statements(2)
    try:
        connection.execute(statements[0])
        locked_version = _pragma_integer(connection, "user_version")
        if locked_version in {2, 3, 4, 5, 6, 7, 8, 9}:
            connection.rollback()
            return False
        if locked_version != 1:
            raise DatabaseConfigurationError(
                f"Control database version changed during upgrade: {locked_version}."
            )
        _verify_exact_schema(connection, version=1)
        _reject_legacy_terminal_residue(connection)
        for statement in statements[1:-1]:
            connection.execute(statement)
        _verify_exact_schema(connection, version=2)
        connection.execute(statements[-1])
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    return True


def _preflight_v2(connection: sqlite3.Connection) -> int:
    try:
        connection.execute("BEGIN")
        snapshot_version = _pragma_integer(connection, "user_version")
        if snapshot_version in {3, 4, 5, 6, 7, 8, 9}:
            connection.commit()
            return snapshot_version
        if snapshot_version != 2:
            raise DatabaseConfigurationError(
                f"Control database version changed during v2 preflight: {snapshot_version}."
            )
        _verify_exact_schema(connection, version=2)
        connection.commit()
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    return 2


def _upgrade_v2_to_v3(connection: sqlite3.Connection) -> bool:
    statements = _migration_statements(3)
    try:
        connection.execute(statements[0])
        locked_version = _pragma_integer(connection, "user_version")
        if locked_version in {3, 4, 5, 6, 7, 8, 9}:
            connection.rollback()
            return False
        if locked_version != 2:
            raise DatabaseConfigurationError(
                f"Control database version changed during upgrade: {locked_version}."
            )
        _verify_exact_schema(connection, version=2)
        for statement in statements[1:-1]:
            connection.execute(statement)
        _verify_exact_schema(connection, version=3)
        connection.execute(statements[-1])
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    return True


def _upgrade_v3_to_v4(connection: sqlite3.Connection) -> bool:
    statements = _migration_statements(4)
    try:
        connection.execute(statements[0])
        locked_version = _pragma_integer(connection, "user_version")
        if locked_version in {4, 5, 6, 7, 8, 9}:
            _verify_exact_schema(connection, version=locked_version)
            connection.rollback()
            return False
        if locked_version != 3:
            raise DatabaseConfigurationError(
                f"Control database version changed during upgrade: {locked_version}."
            )
        _verify_exact_schema(connection, version=3)
        for statement in statements[1:-1]:
            connection.execute(statement)
        _verify_exact_schema(connection, version=4)
        connection.execute(statements[-1])
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    return True


def _upgrade_v4_to_v5(connection: sqlite3.Connection) -> bool:
    statements = _migration_statements(5)
    try:
        connection.execute(statements[0])
        locked_version = _pragma_integer(connection, "user_version")
        if locked_version in {5, 6, 7, 8, 9}:
            _verify_exact_schema(connection, version=locked_version)
            connection.rollback()
            return False
        if locked_version != 4:
            raise DatabaseConfigurationError(
                f"Control database version changed during upgrade: {locked_version}."
            )
        _verify_exact_schema(connection, version=4)
        for statement in statements[1:-1]:
            connection.execute(statement)
        _verify_exact_schema(connection, version=5)
        connection.execute(statements[-1])
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    return True


def _upgrade_v5_to_v6(connection: sqlite3.Connection) -> bool:
    statements = _migration_statements(6)
    try:
        connection.execute(statements[0])
        locked_version = _pragma_integer(connection, "user_version")
        if locked_version in {6, 7, 8, 9}:
            _verify_exact_schema(connection, version=locked_version)
            connection.rollback()
            return False
        if locked_version != 5:
            raise DatabaseConfigurationError("Control database changed during schema6 upgrade.")
        _verify_exact_schema(connection, version=5)
        for statement in statements[1:-1]:
            connection.execute(statement)
        _verify_exact_schema(connection, version=6)
        connection.execute(statements[-1])
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    return True


def _upgrade_v6_to_v7(connection: sqlite3.Connection) -> bool:
    # Snapshot preflight, then repeat exact validation under the write lease.
    try:
        connection.execute("BEGIN")
        version = _pragma_integer(connection, "user_version")
        if version not in {6, 7, 8, 9}:
            raise DatabaseConfigurationError("Control database changed during schema7 preflight.")
        _verify_exact_schema(connection, version=version)
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    statements = _migration_statements(7)
    try:
        connection.execute(statements[0])
        locked_version = _pragma_integer(connection, "user_version")
        if locked_version in {7, 8, 9}:
            _verify_exact_schema(connection, version=locked_version)
            connection.rollback()
            return False
        if locked_version != 6:
            raise DatabaseConfigurationError("Control database changed during schema7 upgrade.")
        _verify_exact_schema(connection, version=6)
        for statement in statements[1:-1]:
            connection.execute(statement)
        _verify_exact_schema(connection, version=7)
        connection.execute(statements[-1])
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    return True


def _upgrade_v7_to_v8(connection: sqlite3.Connection) -> bool:
    # Exact snapshot preflight and write-locked recheck, not executescript.
    try:
        connection.execute("BEGIN")
        version = _pragma_integer(connection, "user_version")
        if version not in {7, 8, 9}:
            raise DatabaseConfigurationError("Control database changed during schema8 preflight.")
        _verify_exact_schema(connection, version=version)
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    statements = _migration_statements(8)
    try:
        connection.execute(statements[0])
        version = _pragma_integer(connection, "user_version")
        if version in {8, 9}:
            _verify_exact_schema(connection, version=version)
            connection.rollback()
            return False
        if version != 7:
            raise DatabaseConfigurationError("Control database changed during schema8 upgrade.")
        _verify_exact_schema(connection, version=7)
        for statement in statements[1:-1]:
            connection.execute(statement)
        _verify_exact_schema(connection, version=8)
        connection.execute(statements[-1])
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    return True


def _upgrade_v8_to_v9(connection: sqlite3.Connection) -> bool:
    # Keep the exact D1/D2 history; the source branch's S03 schema7 is unrelated.
    try:
        connection.execute("BEGIN")
        version = _pragma_integer(connection, "user_version")
        if version not in {8, 9}:
            raise DatabaseConfigurationError("Control database changed during schema9 preflight.")
        _verify_exact_schema(connection, version=version)
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    statements = _migration_statements(9)
    try:
        connection.execute(statements[0])
        version = _pragma_integer(connection, "user_version")
        if version == 9:
            _verify_exact_schema(connection, version=9)
            connection.rollback()
            return False
        if version != 8:
            raise DatabaseConfigurationError("Control database changed during schema9 upgrade.")
        _verify_exact_schema(connection, version=8)
        for statement in statements[1:-1]:
            connection.execute(statement)
        _verify_exact_schema(connection, version=9)
        connection.execute(statements[-1])
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    return True


def _initialize_empty_v1(connection: sqlite3.Connection) -> int:
    statements = _migration_statements(1)
    try:
        connection.execute(statements[0])
        locked_version = _pragma_integer(connection, "user_version")
        if locked_version in {1, 2, 3, 4, 5, 6, 7, 8, 9}:
            connection.rollback()
            return locked_version
        if locked_version != 0:
            raise DatabaseConfigurationError(
                f"Control database version changed during initialization: {locked_version}."
            )
        if _schema_fingerprint(connection):
            raise DatabaseConfigurationError(
                "Refusing to migrate a non-empty unknown version 0 database."
            )
        for statement in statements[1:-1]:
            connection.execute(statement)
        _verify_exact_schema(connection, version=1)
        connection.execute(statements[-1])
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    return 1


def _pragma_integer(connection: sqlite3.Connection, name: str) -> int:
    row = connection.execute(f"PRAGMA {name}").fetchone()
    if row is None or type(row[0]) is not int:
        raise DatabaseConfigurationError(f"SQLite PRAGMA {name} did not return an integer.")
    return int(row[0])
