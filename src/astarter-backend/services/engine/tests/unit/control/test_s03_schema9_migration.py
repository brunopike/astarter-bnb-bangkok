"""Schema9 additive migration, only source-built temporary synthetic databases."""

import multiprocessing
import sqlite3
from hashlib import sha256

import pytest

from stark_trading_os.control import database as db
from tests.unit.control.test_astarter_atomic_migration import populated_v7, rows
from tests.unit.control.test_astarter_strategy_migration import populated_v6
from tests.unit.control.test_historical_configuration_migration import open_process

TABLES = {
    "s03_runs", "s03_events", "s03_signals", "s03_lifecycle", "s03_plan_manifest", "s03_audit",
}


def populated_v8(path):
    conn = populated_v7(path)
    conn.create_function("stark_control_writer_schema_version", 0, lambda: 8, deterministic=True)
    conn.create_function("stark_control_writer_schema8", 0, lambda: 8, deterministic=True)
    conn.executescript(db._migration_sql(8))
    ep = conn.execute("SELECT * FROM astarter_episode_references").fetchone()
    approval = conn.execute("SELECT reference_id FROM astarter_approval_references").fetchone()[0]
    conn.execute(
        "INSERT INTO astarter_admission_heads(account_id,scope_id,purpose,authority_id) "
        "VALUES(?,?,'PLAN_FINITE_ATOMICITY','SYNTHETIC-MIGRATION-NOT-PERMIT')",
        (ep["account_id"], ep["scope_id"]),
    )
    conn.execute(
        "INSERT INTO astarter_admissions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("old-admission", ep["account_id"], ep["scope_id"], ep["binding_id"], ep["episode_id"],
         ep["plan_id"], ep["revision"], approval, 1, "a" * 64, "b" * 64, 900, 2500,
         "READY", "c" * 64),
    )
    conn.execute("UPDATE astarter_admission_heads SET generation=1,admission_id='old-admission'")
    conn.execute("INSERT INTO astarter_intent_admissions VALUES(?,?,?,?)",
                 ("i" * 36, ep["account_id"], ep["binding_id"], "old-admission"))
    db._verify_exact_schema(conn, version=8)
    return conn


def test_populated_v8_preserves_all_legacy_data_schema_objects_and_reopens(tmp_path):
    path = tmp_path / "old.sqlite"
    old = populated_v8(path)
    tables = [row[0] for row in old.execute("SELECT name FROM sqlite_schema WHERE type='table'")]
    before = rows(old, tables)
    schema = db._schema_fingerprint(old)
    old.close()
    for _ in range(2):
        current = db.open_control_database(path)
        try:
            db._verify_exact_schema(current, version=9)
            assert rows(current, tables) == before
            assert set(schema) <= set(db._schema_fingerprint(current))
            assert all(current.execute(f"SELECT count(*) FROM {t}").fetchone()[0] == 0
                       for t in TABLES)
            assert all(current.execute(f"PRAGMA table_list('{t}')").fetchone()[5] == 1
                       for t in TABLES)
        finally:
            current.close()


def test_fresh_v9_registers_current_and_legacy_capabilities(tmp_path):
    conn = db.open_control_database(tmp_path / "fresh.sqlite")
    try:
        db._verify_exact_schema(conn, version=9)
        assert tuple(conn.execute(
            "SELECT stark_control_writer_schema_version(),stark_control_writer_schema7(),"
            "stark_control_writer_schema8(),stark_control_writer_schema9()"
        ).fetchone()) == (9, 7, 8, 9)
    finally:
        conn.close()


def test_open_v8_writer_all_tables_all_mutations_and_cached_statements_rejected(tmp_path):
    path = tmp_path / "old.sqlite"
    old = populated_v8(path)
    cached = "UPDATE runs SET created_at_ns=created_at_ns WHERE 0"
    old.execute(cached)
    current = db.open_control_database(path)
    try:
        before = tuple(current.iterdump())
        with pytest.raises(sqlite3.OperationalError, match="stark_control_writer_schema9"):
            old.execute(cached)
        tables = [row[0] for row in current.execute(
            "SELECT name FROM sqlite_schema WHERE type='table'")]
        for table in tables:
            col = current.execute(f"PRAGMA table_info({table})").fetchone()[1]
            for sql in (f"UPDATE {table} SET {col}={col} WHERE 0", f"DELETE FROM {table} WHERE 0",
                        f"INSERT INTO {table} SELECT * FROM {table} WHERE 0"):
                with pytest.raises(sqlite3.OperationalError, match="stark_control_writer_schema9"):
                    old.execute(sql)
                current.execute(sql)
        assert tuple(current.iterdump()) == before
        with pytest.raises(sqlite3.OperationalError, match="stark_control_writer_schema9"):
            old.execute("UPDATE runs SET created_at_ns=11 WHERE run_id='bt_old'")
        current.execute("UPDATE runs SET created_at_ns=11 WHERE run_id='bt_old'")
    finally:
        old.close()
        current.close()


@pytest.mark.parametrize("failure", ["ddl", "commit", "cancel"])
def test_v9_failed_transaction_restores_exact_v8_bytes_schema_and_rows(
    tmp_path, monkeypatch, failure,
):
    conn = populated_v8(tmp_path / "old.sqlite")
    before = conn.serialize(), tuple(conn.iterdump()), db._schema_fingerprint(conn)
    db._expected_schema_fingerprint(9)
    original = db._migration_sql
    reached = []

    def trace(sql):
        if "CREATE TABLE s03_runs" in sql:
            reached.append(sql)

    def deny(action, arg, _arg2, _db, _trigger):
        if reached and action == sqlite3.SQLITE_TRANSACTION and arg == "COMMIT":
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    if failure == "ddl":
        def broken(version):
            sql = original(version)
            return sql.replace("PRAGMA user_version = 9;", "SELECT missing_column;\n"
                               "PRAGMA user_version = 9;") if version == 9 else sql
        monkeypatch.setattr(db, "_migration_sql", broken)
    else:
        conn.set_trace_callback(trace)
        if failure == "commit":
            conn.set_authorizer(deny)
        else:
            conn.set_progress_handler(lambda: int(bool(reached)), 1)
    with pytest.raises(sqlite3.DatabaseError):
        db._upgrade_v8_to_v9(conn)
    conn.set_authorizer(None)
    conn.set_trace_callback(None)
    conn.set_progress_handler(None, 0)
    monkeypatch.setattr(db, "_migration_sql", original)
    assert not conn.in_transaction
    assert (conn.serialize(), tuple(conn.iterdump()), db._schema_fingerprint(conn)) == before
    db._verify_exact_schema(conn, version=8)
    assert db._upgrade_v8_to_v9(conn)
    db._verify_exact_schema(conn, version=9)
    conn.close()


@pytest.mark.parametrize("damage", ["extra", "trigger", "future"])
def test_v9_rejects_damaged_v8_without_partial_upgrade(tmp_path, damage):
    path = tmp_path / "bad.sqlite"
    conn = populated_v8(path)
    if damage == "extra":
        conn.execute("CREATE TABLE unexpected(x)")
    elif damage == "trigger":
        conn.execute("DROP TRIGGER d2_astarter_accounts_u")
    else:
        conn.execute("PRAGMA user_version=10")
    before = conn.serialize(), tuple(conn.iterdump())
    with pytest.raises(db.DatabaseConfigurationError):
        db.open_control_database(path)
    assert (conn.serialize(), tuple(conn.iterdump())) == before
    conn.close()


def test_source_s03_schema7_is_not_target_d1_schema7(tmp_path):
    path = tmp_path / "source-branch.sqlite"
    conn = populated_v6(path)
    # Reproduce the frozen source branch's six tables and its generic v7 guards.
    ddl = db._migration_sql(9).split("CREATE TRIGGER", 1)[0]
    conn.executescript(ddl + "COMMIT;")
    for row in conn.execute("SELECT name FROM sqlite_schema WHERE type='trigger'").fetchall():
        if "_schema6_" in row[0]:
            conn.execute(f"DROP TRIGGER {row[0]}")
    tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_schema WHERE type='table'")]
    for table in tables:
        for operation in ("insert", "update", "delete"):
            conn.execute(f"CREATE TRIGGER trg_{table}_schema7_{operation} "
                         f"BEFORE {operation.upper()} ON {table}\n"
                         "WHEN stark_control_writer_schema_version() <> 7\n"
                         "BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;")
    conn.execute("PRAGMA user_version=7")
    # Exact frozen SOURCE 87a51f5 schema7, without an external checkout dependency.
    assert sha256(repr(db._schema_fingerprint(conn)).encode()).hexdigest() == (
        "78627fb696855a42472e9434afabbc526a2f6af9a52dc28d3d7643385cc0f123"
    )
    before = conn.serialize(), tuple(conn.iterdump())
    with pytest.raises(db.DatabaseConfigurationError, match="fingerprint"):
        db.open_control_database(path)
    assert (conn.serialize(), tuple(conn.iterdump())) == before
    conn.close()


@pytest.mark.parametrize("starting_version", [0, 6, 7, 8])
def test_v9_two_process_bootstrap(tmp_path, starting_version):
    path = tmp_path / "race.sqlite"
    if starting_version:
        {6: populated_v6, 7: populated_v7, 8: populated_v8}[starting_version](path).close()
    ctx = multiprocessing.get_context("spawn")
    barrier, queue = ctx.Barrier(2), ctx.Queue()
    workers = [ctx.Process(target=open_process, args=(str(path), barrier, queue)) for _ in range(2)]
    try:
        for worker in workers:
            worker.start()
        assert [queue.get(timeout=30) for _ in workers] == [("ok", 9), ("ok", 9)]
        for worker in workers:
            worker.join(timeout=10)
            assert worker.exitcode == 0
    finally:
        for worker in workers:
            if worker.is_alive():
                worker.terminate()
                worker.join(timeout=5)
        queue.close()


@pytest.mark.parametrize("upgrade", [db._upgrade_v6_to_v7, db._upgrade_v7_to_v8])
def test_legacy_upgrade_rechecks_concurrently_completed_v9(tmp_path, upgrade):
    conn = db.open_control_database(tmp_path / "current.sqlite")
    try:
        db._verify_exact_schema(conn, version=9)
        assert upgrade(conn) is False
        db._verify_exact_schema(conn, version=9)
    finally:
        conn.close()


@pytest.mark.parametrize("starting_version", [6, 7, 8])
def test_bootstrap_rechecks_upgrade_completed_between_preflight_and_lock(
    tmp_path, monkeypatch, starting_version,
):
    path = tmp_path / "concurrent.sqlite"
    conn = {6: populated_v6, 7: populated_v7, 8: populated_v8}[starting_version](path)
    original = db._migration_statements
    changed = []

    def complete_other_connection(version):
        if version == starting_version + 1 and not changed:
            changed.append(True)
            db.open_control_database(path).close()
        return original(version)

    monkeypatch.setattr(db, "_migration_statements", complete_other_connection)
    upgrade = {6: db._upgrade_v6_to_v7, 7: db._upgrade_v7_to_v8, 8: db._upgrade_v8_to_v9}
    try:
        assert upgrade[starting_version](conn) is False
        assert changed
        db._verify_exact_schema(conn, version=9)
    finally:
        conn.close()


def test_v9_rechecks_exact_v8_after_acquiring_write_lock(tmp_path, monkeypatch):
    path = tmp_path / "changed.sqlite"
    conn = populated_v8(path)
    original = db._migration_statements
    changed = []

    def change_after_preflight(version):
        statements = original(version)
        if version == 9:
            other = sqlite3.connect(path, isolation_level=None)
            try:
                other.execute("CREATE TABLE unexpected(x)")
            finally:
                other.close()
            changed.append((conn.serialize(), tuple(conn.iterdump())))
        return statements

    monkeypatch.setattr(db, "_migration_statements", change_after_preflight)
    try:
        with pytest.raises(db.DatabaseConfigurationError, match="fingerprint"):
            db._upgrade_v8_to_v9(conn)
        assert not conn.in_transaction
        assert (conn.serialize(), tuple(conn.iterdump())) == changed[0]
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 8
    finally:
        conn.close()


def test_v9_exact_postflight_rolls_back_missing_writer_guard(tmp_path, monkeypatch):
    conn = populated_v8(tmp_path / "postflight.sqlite")
    before = conn.serialize(), tuple(conn.iterdump())
    db._expected_schema_fingerprint(9)
    original = db._migration_sql

    def missing_guard(version):
        sql = original(version)
        return sql.replace("PRAGMA user_version = 9;", "DROP TRIGGER s03_s03_audit_i;\n"
                           "PRAGMA user_version = 9;") if version == 9 else sql

    monkeypatch.setattr(db, "_migration_sql", missing_guard)
    try:
        with pytest.raises(db.DatabaseConfigurationError, match="fingerprint"):
            db._upgrade_v8_to_v9(conn)
        assert not conn.in_transaction
        assert (conn.serialize(), tuple(conn.iterdump())) == before
        db._verify_exact_schema(conn, version=8)
    finally:
        conn.close()
