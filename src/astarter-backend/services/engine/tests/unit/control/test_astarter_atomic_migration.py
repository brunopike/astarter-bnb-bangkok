"""Source-built v7 -> v8 only. No installed databases or copied real data."""

import multiprocessing
import sqlite3

import pytest

from stark_trading_os.control import database as db
from stark_trading_os.control.astarter import strategy_repository as r
from stark_trading_os.domain import strategy_contracts as c
from tests.unit.control.test_astarter_strategy_migration import populated_v6
from tests.unit.control.test_astarter_strategy_repository import SyntheticBackend, checkpoint
from tests.unit.control.test_historical_configuration_migration import open_process
from tests.unit.domain.test_strategy_contracts import approval, changed, ready

TABLES = {"astarter_admission_heads", "astarter_admissions", "astarter_intent_admissions"}


def populated_v7(path):
    conn = populated_v6(path)
    conn.create_function("stark_control_writer_schema7", 0, lambda: 7, deterministic=True)
    conn.executescript(db._migration_sql(7))
    backend = SyntheticBackend()
    sid = c.contract_hash(backend.assignment.binding)
    bundle = changed(ready(), approval=None)
    p = bundle.plan
    r._insert(conn, "astarter_strategy_scopes", sid, backend.assignment)
    r._insert(conn, "astarter_strategy_versions", sid, p.spec)
    r._insert(conn, "astarter_plan_versions", sid, r.PlanRecord(
        request_key="old-plan", ordinal=1, previous_revision=None, bundle=bundle))
    r._insert(conn, "astarter_approval_references", sid, r.ApprovalRecord(
        request_key="old-approval", plan_id=p.plan_id, approval=approval(p)))
    ep = r.EpisodeReference(binding=p.binding, episode_id="old-episode", plan_id=p.plan_id,
                            revision=p.revision, plan_sha256=c.contract_hash(p),
                            binding_id="b" * 36)
    r._insert(conn, "astarter_episode_references", sid, ep)
    cp = checkpoint(p, episode_id=ep.episode_id)
    r._insert(conn, "astarter_layer_references", sid, r.LayerReference(
        binding=p.binding, episode_id=ep.episode_id, layer_index=0, mode="VIRTUAL",
        action_id="old-action", trigger=cp.causal, disposition="UNKNOWN"))
    r._insert(conn, "astarter_recovery_checkpoints", sid, cp)
    db._verify_exact_schema(conn, version=7)
    return conn


def rows(conn, tables):
    result = {}
    for table in sorted(tables):
        columns = tuple(tuple(row) for row in conn.execute(f"PRAGMA table_info({table})"))
        raw = conn.execute(f"SELECT * FROM {table}").fetchall()
        result[table] = columns, sorted((tuple(row) for row in raw), key=repr)
    return result


def test_exact_v7_upgrade_preserves_all_rows_columns_and_existing_triggers(tmp_path):
    path = tmp_path / "old.sqlite"
    old = populated_v7(path)
    tables = [row[0] for row in old.execute("SELECT name FROM sqlite_schema WHERE type='table'")]
    before = rows(old, tables)
    triggers = dict(old.execute("SELECT name,sql FROM sqlite_schema WHERE type='trigger'"))
    old.close()
    for _ in range(2):
        current = db.open_control_database(path)
        try:
            db._verify_exact_schema(current, version=9)
            assert rows(current, tables) == before
            assert {name: current.execute("SELECT sql FROM sqlite_schema WHERE name=?", (name,))
                    .fetchone()[0] for name in triggers} == triggers
            for table in TABLES:
                assert current.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
                with pytest.raises(sqlite3.OperationalError, match="rowid"):
                    current.execute(f"SELECT rowid FROM {table}")
        finally:
            current.close()


@pytest.mark.parametrize("failure", ["ddl", "commit", "cancel"])
def test_v8_migration_actual_failure_rolls_back_then_retries(tmp_path, monkeypatch, failure):
    conn = populated_v7(tmp_path / "old.sqlite")
    before = tuple(conn.iterdump())
    db._expected_schema_fingerprint(8)
    original = db._migration_sql
    reached = []

    def trace(sql):
        if "CREATE TABLE astarter_admission_heads" in sql:
            reached.append(sql)

    def deny(action, arg, _arg2, _db, _trigger):
        if reached and action == sqlite3.SQLITE_TRANSACTION and arg == "COMMIT":
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    if failure == "ddl":
        def broken(version):
            sql = original(version)
            return sql.replace("PRAGMA user_version = 8;", "SELECT missing_column;\n"
                               "PRAGMA user_version = 8;") if version == 8 else sql
        monkeypatch.setattr(db, "_migration_sql", broken)
    else:
        conn.set_trace_callback(trace)
        if failure == "commit":
            conn.set_authorizer(deny)
        else:
            conn.set_progress_handler(lambda: int(bool(reached)), 1)
    with pytest.raises(sqlite3.DatabaseError):
        db._upgrade_v7_to_v8(conn)
    conn.set_authorizer(None)
    conn.set_trace_callback(None)
    conn.set_progress_handler(None, 0)
    monkeypatch.setattr(db, "_migration_sql", original)
    assert not conn.in_transaction
    assert tuple(conn.iterdump()) == before
    db._verify_exact_schema(conn, version=7)
    assert db._upgrade_v7_to_v8(conn)
    db._verify_exact_schema(conn, version=8)
    conn.close()


def test_v7_cached_writer_cannot_prepare_any_v8_table_mutation(tmp_path):
    path = tmp_path / "old.sqlite"
    old = populated_v7(path)
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
    finally:
        old.close()
        current.close()


@pytest.mark.parametrize("existing", [False, True])
def test_v8_two_process_bootstrap(tmp_path, existing):
    path = tmp_path / "race.sqlite"
    if existing:
        populated_v7(path).close()
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


@pytest.mark.parametrize("damage", ["extra", "trigger", "future"])
def test_v8_preflight_rejects_modified_v7_without_partial_upgrade(tmp_path, damage):
    path = tmp_path / "bad.sqlite"
    conn = populated_v7(path)
    if damage == "extra":
        conn.execute("CREATE TABLE unexpected(x)")
    elif damage == "trigger":
        conn.execute("DROP TRIGGER trg_strategy_scopes_update")
    else:
        conn.execute("PRAGMA user_version=10")
    before = tuple(conn.iterdump())
    with pytest.raises(db.DatabaseConfigurationError):
        db.open_control_database(path)
    assert tuple(conn.iterdump()) == before
    conn.close()
