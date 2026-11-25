"""Q05-D1: only source-built temporary SQLite databases, never installed data."""

import multiprocessing
import sqlite3

import pytest

from stark_trading_os.control import database as db
from tests.unit.control.test_historical_configuration_migration import open_process

TABLES = {
    "astarter_strategy_scopes", "astarter_strategy_versions", "astarter_plan_versions",
    "astarter_approval_references", "astarter_episode_references",
    "astarter_layer_references", "astarter_recovery_checkpoints",
}


def legacy_v6(path):
    c = sqlite3.connect(path, isolation_level=None)
    c.row_factory = sqlite3.Row
    c.create_function("stark_control_writer_schema_version", 0, lambda: 6, deterministic=True)
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=FULL")
    c.execute("PRAGMA busy_timeout=5000")
    for version in range(1, 7):
        c.executescript(db._migration_sql(version))
    return c


def test_empty_database_is_exact_v7(tmp_path):
    c = db.open_control_database(tmp_path / "empty.sqlite")
    try:
        assert c.execute("PRAGMA user_version").fetchone()[0] == 9
        names = {r[0] for r in c.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
        assert TABLES <= names
        for table in TABLES:
            with pytest.raises(sqlite3.OperationalError, match="rowid"):
                c.execute(f"SELECT rowid FROM {table}")
        db._verify_exact_schema(c, version=9)
        assert c.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert c.execute("PRAGMA synchronous").fetchone()[0] == 2
        assert c.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    finally:
        c.close()


@pytest.mark.parametrize("statement", [
    "UPDATE runs SET created_at_ns=created_at_ns WHERE 0",
    "DELETE FROM runs WHERE 0",
    "INSERT INTO runs(run_id,state,created_at_ns) SELECT 'bt_none','DRAFT',1 WHERE 0",
])
def test_open_v6_writer_rejects_even_zero_row_statements(tmp_path, statement):
    path = tmp_path / "old.sqlite"
    old = legacy_v6(path)
    # Cache the old prepared statement before migration too.
    old.execute(statement)
    new = db.open_control_database(path)
    try:
        with pytest.raises(sqlite3.OperationalError, match="stark_control_writer_schema9"):
            old.execute(statement)
    finally:
        old.close()
        new.close()


def rows(conn, tables):
    return {t: tuple(tuple(r) for r in conn.execute(f'SELECT * FROM "{t}" ORDER BY rowid'))
            for t in tables}


def populated_v6(path):
    conn = legacy_v6(path)
    conn.execute("INSERT INTO runs(run_id,state,created_at_ns) VALUES('bt_old','DRAFT',10)")
    conn.execute(
        "INSERT INTO strategy_drafts VALUES(?,?,?,?,?,?,?)",
        ("sd_" + "a" * 32, b"old-config", "a" * 64, 6, 1700000000000000000,
         1700000000000000000, "StrategyConfigurationInput.v1"),
    )
    conn.execute(
        "INSERT INTO strategy_configuration_versions VALUES(?,?,?,?,?,?,?,?)",
        ("cfg_" + "a" * 32, "sd_" + "a" * 32, 1, 6, b"old-config", "a" * 64,
         1700000000000000000, "StrategyConfigurationInput.v1"),
    )
    conn.execute(
        "INSERT INTO astarter_accounts(account_id,venue_session,baseline_quote,risk_period,"
        "lock_fraction,hard_locks) VALUES(?,?,?,?,?,?)",
        ("account-a", "11111111-1111-1111-1111-111111111111", "10000.000000000000000001",
         "old-period", "0.2", b'["UNKNOWN"]'),
    )
    bid, iid = "b" * 36, "i" * 36
    conn.execute("INSERT INTO astarter_bindings VALUES(?,?,?,?,?,?)",
                 (bid, "account-a", "c" * 64, b"old-policy", "d" * 64, "REVOKED"))
    conn.execute("INSERT INTO astarter_limits VALUES('account-a','PRIVATE','0.001','0.0001')")
    conn.execute(
        "INSERT INTO astarter_intents(intent_id,account_id,binding_id,opportunity_key,"
        "request_sha256,receipt_bytes,entry_order_id,state,pending_risk,cash_hold) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (iid, "account-a", bid, "old-opportunity", "e" * 64, b"old-receipt", "old-order",
         "RECONCILING", "0.000000000000000001", "221.46284528"),
    )
    conn.execute(
        "INSERT INTO astarter_orders(order_id,account_id,intent_id,role,quantity,native_state) "
        "VALUES('old-order','account-a',?,'ENTRY','0.00368','UNKNOWN')", (iid,),
    )
    conn.execute("INSERT INTO astarter_fills VALUES(?,?,?,?,?)",
                 ("account-a", "old-order", "old-trade", b"old-fill-reference", "f" * 64))
    conn.execute("INSERT INTO astarter_settlements VALUES(?,?,?,?,?,?)",
                 ("account-a", "a" * 64, "b" * 64, "1.000000000000000001", "0.2", b"old-ref"))
    conn.execute("INSERT INTO astarter_audit VALUES(?,?,?,?,?)",
                 ("account-a", 1, "FIXTURE_NOT_NATIVE", b"old-audit", "c" * 64))
    return conn


def test_exact_v6_upgrade_preserves_every_old_row_column_and_immutable_trigger(tmp_path):
    path = tmp_path / "populated.sqlite"
    old = populated_v6(path)
    tables = tuple(r[0] for r in old.execute("SELECT name FROM sqlite_schema WHERE type='table'"))
    before = rows(old, tables)
    triggers = {r[0]: r[1] for r in old.execute(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name NOT LIKE '%schema6%'"
    )}
    db._verify_exact_schema(old, version=6)
    old.close()
    for _ in range(2):
        current = db.open_control_database(path)
        try:
            assert rows(current, tables) == before
            assert {name: current.execute("SELECT sql FROM sqlite_schema WHERE name=?", (name,))
                    .fetchone()[0] for name in triggers} == triggers
            assert current.execute(
                "SELECT count(*) FROM astarter_approval_references"
            ).fetchone()[0] == 0
            assert current.execute(
                "SELECT count(*) FROM astarter_strategy_scopes"
            ).fetchone()[0] == 0
            db._verify_exact_schema(current, version=9)
        finally:
            current.close()


@pytest.mark.parametrize("failure", ["ddl", "commit", "cancel"])
def test_migration_failure_rolls_back_exact_v6_then_recovers(tmp_path, monkeypatch, failure):
    path = tmp_path / "failure.sqlite"
    conn = populated_v6(path)
    before = tuple(conn.iterdump())
    fingerprint = db._schema_fingerprint(conn)
    # Freeze the reference from the actual unmodified source, not fault-injected SQL.
    db._expected_schema_fingerprint(7)
    original = db._migration_sql
    reached = False

    def trace(sql):
        nonlocal reached
        if "PRAGMA user_version = 7" in sql or "CREATE TABLE astarter_strategy_versions" in sql:
            reached = True

    def authorizer(action, arg, _arg2, _database, _trigger):
        if reached and action == sqlite3.SQLITE_TRANSACTION and arg == "COMMIT":
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    if failure == "ddl":
        def broken(version):
            sql = original(version)
            return sql.replace("PRAGMA user_version = 7;", "SELECT no_such_column;\n"
                               "PRAGMA user_version = 7;") if version == 7 else sql
        monkeypatch.setattr(db, "_migration_sql", broken)
    else:
        conn.set_trace_callback(trace)
        if failure == "commit":
            conn.set_authorizer(authorizer)
        else:
            conn.set_progress_handler(lambda: int(reached), 1)
    with pytest.raises(sqlite3.DatabaseError):
        db._upgrade_v6_to_v7(conn)
    conn.set_authorizer(None)
    conn.set_trace_callback(None)
    conn.set_progress_handler(None, 0)
    monkeypatch.setattr(db, "_migration_sql", original)
    assert not conn.in_transaction
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 6
    assert db._schema_fingerprint(conn) == fingerprint
    assert tuple(conn.iterdump()) == before
    assert db._upgrade_v6_to_v7(conn)
    db._verify_exact_schema(conn, version=7)
    conn.close()


@pytest.mark.parametrize("damage", ["extra-table", "drop-trigger", "future", "unknown-zero"])
def test_corrupt_or_unknown_schema_rejected_without_partial_migration(tmp_path, damage):
    path = tmp_path / "corrupt.sqlite"
    conn = legacy_v6(path)
    if damage == "extra-table":
        conn.execute("CREATE TABLE unexpected(x)")
    elif damage == "drop-trigger":
        conn.execute("DROP TRIGGER trg_astarter_accounts_schema6_insert")
    else:
        conn.execute("PRAGMA user_version=" + ("10" if damage == "future" else "0"))
    before = tuple(conn.iterdump())
    with pytest.raises(db.DatabaseConfigurationError):
        db.open_control_database(path)
    assert tuple(conn.iterdump()) == before
    conn.close()


@pytest.mark.parametrize("existing", [False, True])
def test_two_process_bootstrap_exact_final_schema(tmp_path, existing):
    path = tmp_path / "race.sqlite"
    if existing:
        populated_v6(path).close()
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
    conn = db.open_control_database(path)
    db._verify_exact_schema(conn, version=9)
    conn.close()


def test_open_v6_writer_all_tables_all_operations_zero_rows(tmp_path):
    path = tmp_path / "all-tables.sqlite"
    old = legacy_v6(path)
    current = db.open_control_database(path)
    try:
        tables = [r[0] for r in current.execute(
            "SELECT name FROM sqlite_schema WHERE type='table'"
        )]
        for table in tables:
            column = current.execute(f"PRAGMA table_info({table})").fetchone()[1]
            for sql in (
                f"UPDATE {table} SET {column}={column} WHERE 0",
                f"DELETE FROM {table} WHERE 0",
                f"INSERT INTO {table} SELECT * FROM {table} WHERE 0",
            ):
                with pytest.raises(sqlite3.OperationalError, match="stark_control_writer_schema9"):
                    old.execute(sql)
                current.execute(sql)
    finally:
        old.close()
        current.close()
