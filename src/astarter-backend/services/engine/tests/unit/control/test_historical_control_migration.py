"""Version-five run kinds and the fence against still-open old writers."""

import multiprocessing
import sqlite3

import pytest

from stark_trading_os.control import database
from tests.unit.control.test_historical_configuration_migration import open_process, snapshot


def exact_v4(path):
    connection = sqlite3.connect(path, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.create_function("stark_control_writer_schema_version", 0, lambda: 4)
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA journal_mode=WAL")
    for version in (1, 2, 3, 4):
        connection.executescript(database._migration_sql(version))
    return connection


def test_upgrade_preserves_old_run_columns_and_all_other_rows(tmp_path):
    path = tmp_path / "control.sqlite"
    old = exact_v4(path)
    old.execute("INSERT INTO runs(run_id,state,created_at_ns) VALUES('bt_old','DRAFT',10)")
    for scope, target, status in (
        ("backtest.preflight", None, 200),
        ("backtest.create", None, 202),
        ("backtest.cancel/bt_old", "bt_old", 202),
    ):
        old.execute(
            "INSERT INTO idempotency_records VALUES(?,?,?,?,?,?,?,?,?)",
            (
                scope,
                "original-key",
                "0" * 64,
                b'{"request":"original"}',
                status,
                b'{"original":"response"}',
                target,
                "bt_old",
                10,
            ),
        )
    old_receipts = [tuple(row) for row in old.execute("SELECT * FROM idempotency_records")]
    before = dict(old.execute("SELECT * FROM runs").fetchone())
    old.close()
    current = database.open_control_database(path)
    try:
        assert current.execute("PRAGMA user_version").fetchone()[0] == 9
        assert dict(current.execute("SELECT * FROM runs").fetchone()) == (
            before | {"contract_kind": "PROBE_V1"}
        )
        assert [tuple(row) for row in current.execute("SELECT * FROM idempotency_records")] == (
            old_receipts
        )
        saved = snapshot(current)
    finally:
        current.close()
    reopened = database.open_control_database(path)
    try:
        assert snapshot(reopened) == saved
    finally:
        reopened.close()


def test_failed_fifth_migration_rolls_back_every_schema_change(tmp_path, monkeypatch):
    path = tmp_path / "rollback.sqlite"
    old = exact_v4(path)
    old.execute("INSERT INTO runs(run_id,state,created_at_ns) VALUES('bt_old','DRAFT',10)")
    before = snapshot(old)
    old.close()
    original = database._migration_sql

    def broken(version):
        sql = original(version)
        if version == 5:
            return sql.replace(
                "PRAGMA user_version = 5;",
                "INSERT INTO missing VALUES(1);\nPRAGMA user_version = 5;",
            )
        return sql

    monkeypatch.setattr(database, "_migration_sql", broken)
    with pytest.raises((sqlite3.Error, database.DatabaseConfigurationError)):
        database.open_control_database(path)
    after = sqlite3.connect(path, isolation_level=None)
    try:
        assert after.execute("PRAGMA user_version").fetchone()[0] == 4
        assert snapshot(after) == before
    finally:
        after.close()


def test_two_processes_upgrade_four_to_five_once(tmp_path):
    path = tmp_path / "race.sqlite"
    exact_v4(path).close()
    context = multiprocessing.get_context("spawn")
    barrier, queue = context.Barrier(2), context.Queue()
    processes = [
        context.Process(target=open_process, args=(str(path), barrier, queue)) for _ in range(2)
    ]
    try:
        for process in processes:
            process.start()
        assert [queue.get(timeout=30) for _ in processes] == [("ok", 9), ("ok", 9)]
        for process in processes:
            process.join(timeout=30)
            assert process.exitcode == 0
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=5)
        queue.close()


@pytest.mark.parametrize("operation", ["insert", "update", "delete"])
def test_cached_schema4_statements_cannot_write_after_upgrade(tmp_path, operation):
    path = tmp_path / "old-open.sqlite"
    old = exact_v4(path)
    old.execute("INSERT INTO runs(run_id,state,created_at_ns) VALUES('bt_old','DRAFT',10)")
    statement = {
        "insert": "INSERT INTO runs(run_id,state,created_at_ns) VALUES('bt_late','DRAFT',10)",
        "update": "UPDATE runs SET state_version=state_version+1 WHERE run_id='bt_old'",
        "delete": "DELETE FROM runs WHERE run_id='bt_old'",
    }[operation]
    old.execute("BEGIN IMMEDIATE")
    old.execute(statement)
    old.rollback()
    current = database.open_control_database(path)
    try:
        before = snapshot(current)
        with pytest.raises(sqlite3.OperationalError, match="stark_control_writer_schema9"):
            old.execute(statement)
        assert snapshot(current) == before
        with database._immediate_transaction(current):
            current.execute(statement)
    finally:
        old.close()
        current.close()


def test_closed_immutable_run_kind(tmp_path):
    connection = database.open_control_database(tmp_path / "kinds.sqlite")
    try:
        connection.execute(
            "INSERT INTO runs(run_id,state,created_at_ns,contract_kind) "
            "VALUES('bt_new','DRAFT',10,'HISTORICAL_SMA_V2')"
        )
        for value in ("PROBE_V1", "unknown", None):
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute(
                    "UPDATE runs SET contract_kind=? WHERE run_id='bt_new'", (value,)
                )
        for value in ("unknown", None):
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO runs(run_id,state,created_at_ns,contract_kind) "
                    "VALUES('bt_bad','DRAFT',10,?)",
                    (value,),
                )
    finally:
        connection.close()


def test_schema4_binary_refuses_reopen_without_mutation(tmp_path, monkeypatch):
    path = tmp_path / "older-binary.sqlite"
    current = database.open_control_database(path)
    before = snapshot(current)
    current.close()
    monkeypatch.setattr(database, "_SCHEMA_VERSION", 4)
    with pytest.raises(database.DatabaseConfigurationError, match="newer"):
        database.open_control_database(path)
    verify = sqlite3.connect(path, isolation_level=None)
    try:
        assert snapshot(verify) == before
    finally:
        verify.close()
